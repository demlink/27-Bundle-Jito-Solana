import { connection, wallet, walletconn, RayLiqPoolv4, tipAcct, payer } from "../config";
import { PublicKey, ComputeBudgetProgram, VersionedTransaction,  TransactionInstruction, TransactionMessage, SystemProgram, Keypair, LAMPORTS_PER_SOL, AddressLookupTableAccount } from '@solana/web3.js';
import { DEFAULT_TOKEN, LP_MINT_ASSOCIATED_SEED, PROGRAMIDS, addLookupTableInfo, makeTxVersion } from './clients/constants';
import { TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';
import { Liquidity, MARKET_STATE_LAYOUT_V3, Token, TokenAmount, simulateTransaction, Market, MAINNET_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import { BN, LangErrorCode, Wallet } from "@project-serum/anchor";
import { ammCreatePool, getWalletTokenAccount } from "./clients/raydiumUtil";
import { loadKeypairs } from './createKeys';
import { lookupTableProvider } from "./clients/LookupTableProvider";
//import { getRandomTipAccount } from "./clients/config";
import NodeWallet from "@project-serum/anchor/dist/cjs/nodewallet";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import promptSync from 'prompt-sync';
import * as spl from '@solana/spl-token';
import { IPoolKeys } from './clients/interfaces';
import { derivePoolKeys } from "./clients/poolKeysReassigned"; 
import path from 'path';
import fs from 'fs';
import { Key } from "readline";
import { sendBundle } from './jitoPool';

const prompt = promptSync();
const keyInfoPath = path.join(__dirname, 'keyInfo.json');

function chunkArray<T>(array: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(array.length / size) }, (v, i) =>
        array.slice(i * size, i * size + size)
    );
}


export async function createWalletSells() {
    const bundledTxns: VersionedTransaction[] = [];
    const keypairs: Keypair[] = loadKeypairs();

    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(keyInfoPath)) {
        const data = fs.readFileSync(keyInfoPath, 'utf-8');
        poolInfo = JSON.parse(data);
    }

    const lut = new PublicKey(poolInfo.addressLUT.toString());

    const lookupTableAccount = (
        await connection.getAddressLookupTable(lut)
    ).value;

    if (lookupTableAccount == null) {
        console.log("Lookup table account not found!");
        process.exit(0);
    }

    const OpenBookID = prompt('OpenBook MarketID: ') || '';
    const jitoTipAmtInput = prompt('Jito tip in Sol (Ex. 0.01): ') || '0';
    const jitoTipAmt = parseFloat(jitoTipAmtInput) * LAMPORTS_PER_SOL;

    const targetMarketId = new PublicKey(OpenBookID)
    const chunkedKeypairs = chunkArray(keypairs, 7); // EDIT CHUNKS?
    const keys = await derivePoolKeys(targetMarketId);

    // Call local blockhash
    const { blockhash } = await connection.getLatestBlockhash('finalized');

    // Iterate over each chunk of keypairs
    for (let chunkIndex = 0; chunkIndex < chunkedKeypairs.length; chunkIndex++) {
        const chunk = chunkedKeypairs[chunkIndex];
        const instructionsForChunk: TransactionInstruction[] = [];

        // Iterate over each keypair in the chunk to create swap instructions
        for (let i = 0; i < chunk.length; i++) {
            const keypair = chunk[i];
            console.log(`Processing keypair ${i + 1}/${chunk.length}:`, keypair.publicKey.toString());

            if (keys == null) {
                console.log("Error fetching poolkeys");
                process.exit(0);
            }

            const TokenATA = await spl.getAssociatedTokenAddress(
                new PublicKey(keys.baseMint),
                keypair.publicKey,
            );

            const wSolATA = await spl.getAssociatedTokenAddress(
                spl.NATIVE_MINT,
                keypair.publicKey,
            );

            const { sellIxs } = makeSell(keys, wSolATA, TokenATA, true, keypair); //  CHANGE FOR SELL (sellIxs/true)

            instructionsForChunk.push(...sellIxs); // CHANGE FOR SELL (sellIxs)
        }

        if (chunkIndex === chunkedKeypairs.length - 1) {
            const tipSwapIxn = SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: tipAcct,
                lamports: BigInt(jitoTipAmt),
            });
            instructionsForChunk.push(tipSwapIxn);
            console.log('Jito tip added :).');
        }

        const message = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: instructionsForChunk,
        }).compileToV0Message([lookupTableAccount]);

        const versionedTx = new VersionedTransaction(message);

        const serializedMsg = versionedTx.serialize();
        console.log("Txn size:", serializedMsg.length);
        if (serializedMsg.length > 1232) { console.log('tx too big'); }
        
        console.log("Signing transaction with chunk signers", chunk.map(kp => kp.publicKey.toString()));

        for (const keypair of chunk) {
            versionedTx.sign([keypair]);
        }
        versionedTx.sign([payer])


        bundledTxns.push(versionedTx);
    }

    // FINALLY SEND
    await sendBundle(bundledTxns);



    bundledTxns.length = 0;   // Reset bundledTxns array
    return;
}

async function fetchTokenBalance(TokenPubKey: string, decimalsToken: number, keypair: Keypair) {
    const ownerPubKey = keypair.publicKey;

    const response = await connection.getParsedTokenAccountsByOwner(ownerPubKey, {
        mint: new PublicKey(TokenPubKey),
    });

    let TokenBalance = 0;
    for (const account of response.value) {
        const amount = account.account.data.parsed.info.tokenAmount.uiAmount;
        TokenBalance += amount;
    }

    return TokenBalance * (10 ** decimalsToken);
}

export async function sellXPercentage() {
    const bundledTxns = [];
    const keypairs = loadKeypairs(); // Ensure this function is correctly defined to load your Keypairs

    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(keyInfoPath)) {
        const data = fs.readFileSync(keyInfoPath, 'utf-8');
        poolInfo = JSON.parse(data);
    }

    const lut = new PublicKey(poolInfo.addressLUT.toString());

    const lookupTableAccount = (
        await connection.getAddressLookupTable(lut)
    ).value;

    if (lookupTableAccount == null) {
        console.log("Lookup table account not found!");
        process.exit(0);
    }

    const OpenBookID = prompt('OpenBook MarketID: ') || '';
    const inputPercentageOfSupply = prompt('Percentage to sell (Ex. 1 for 1%): ') || '1';
    const jitoTipAmtInput = prompt('Jito tip in Sol (Ex. 0.01): ') || '0';
    const jitoTipAmt = parseFloat(jitoTipAmtInput) * LAMPORTS_PER_SOL;
    const supplyPercent = parseFloat(inputPercentageOfSupply) / 100;

    const targetMarketId = new PublicKey(OpenBookID);
    const chunkedKeypairs = chunkArray(keypairs, 7); // Adjust chunk size as needed
    const keys = await derivePoolKeys(targetMarketId); // Ensure this function is correctly defined to derive necessary keys

    if (keys == null) {
        console.log('Keys not found!');
        process.exit(0);
    }

    const PayerTokenATA = await spl.getAssociatedTokenAddress(new PublicKey(keys.baseMint), payer.publicKey);
    const { blockhash } = await connection.getLatestBlockhash('finalized');

    for (let chunk of chunkedKeypairs) {
        const instructionsForChunk = [];

        for (let keypair of chunk) {
            const tokenBalanceRaw = await fetchTokenBalance(keys.baseMint.toString(), keys.baseDecimals, keypair);
            const transferAmount = Math.floor(tokenBalanceRaw * supplyPercent);

            if (transferAmount > 0) {
                const TokenATA = await spl.getAssociatedTokenAddress(new PublicKey(keys.baseMint), keypair.publicKey);
                const transferIx = spl.createTransferInstruction(TokenATA, PayerTokenATA, keypair.publicKey, transferAmount);
                instructionsForChunk.push(transferIx);
            }
        }

        if (instructionsForChunk.length > 0) {
            const message = new TransactionMessage({
                payerKey: payer.publicKey,
                recentBlockhash: blockhash,
                instructions: instructionsForChunk,
            }).compileToV0Message([lookupTableAccount]);

            const versionedTx = new VersionedTransaction(message);

            versionedTx.sign([payer]); // Sign with payer first

            for (let keypair of chunk) {
                versionedTx.sign([keypair]); // Then sign with each keypair in the chunk
            }

            bundledTxns.push(versionedTx);
        }
    }

    const PayerwSolATA = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, payer.publicKey);
    const sellPayerIxs = [];
    // Assume makeSell function is defined and creates sell instructions
    const { sellIxs } = makeSell(keys, PayerwSolATA, PayerTokenATA, true, payer);

    const tipSwapIxn = SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: tipAcct, // Make sure 'tipAcct' is defined where you want to send the tip
        lamports: BigInt(jitoTipAmt),
    });

    sellPayerIxs.push(...sellIxs, tipSwapIxn);

    const sellMessage = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: sellPayerIxs,
    }).compileToV0Message([lookupTableAccount]);

    const sellTx = new VersionedTransaction(sellMessage);
    sellTx.sign([payer]);
    bundledTxns.push(sellTx);

    // SEND BUNDLE
    if (bundledTxns.length > 0) {
        await sendBundle(bundledTxns); // Ensure sendBundle function is correctly defined to send transactions
    }

    return;
}

function makeSell(
    poolKeys: IPoolKeys, 
    wSolATA: PublicKey,
    TokenATA: PublicKey,
    reverse: boolean,
    keypair: Keypair,
  ) { 
  const programId = new PublicKey('Axz6g5nHgKzm5CbLJcAQauxpdpkL1BafBywSvotyTUSv'); // MY PROGRAM
  const account1 = TOKEN_PROGRAM_ID; // token program
  const account2 = poolKeys.id; // amm id  writable
  const account3 = poolKeys.authority; // amm authority
  const account4 = poolKeys.openOrders; // amm open orders  writable
  const account5 = poolKeys.targetOrders; // amm target orders  writable
  const account6 = poolKeys.baseVault; // pool coin token account  writable  AKA baseVault
  const account7 = poolKeys.quoteVault; // pool pc token account  writable   AKA quoteVault
  const account8 = poolKeys.marketProgramId; // serum program id
  const account9 = poolKeys.marketId; //   serum market  writable
  const account10 = poolKeys.marketBids; // serum bids  writable
  const account11 = poolKeys.marketAsks; // serum asks  writable
  const account12 = poolKeys.marketEventQueue; // serum event queue  writable
  const account13 = poolKeys.marketBaseVault; // serum coin vault  writable     AKA marketBaseVault
  const account14 = poolKeys.marketQuoteVault; //   serum pc vault  writable    AKA marketQuoteVault
  const account15 = poolKeys.marketAuthority; // serum vault signer       AKA marketAuthority
  let account16 = wSolATA; // user source token account  writable
  let account17 = TokenATA; // user dest token account   writable
  const account18 = keypair.publicKey; // user owner (signer)  writable
  const account19 = MAINNET_PROGRAM_ID.AmmV4; // ammV4  writable
  
  if (reverse == true) {
    account16 = TokenATA;
    account17 = wSolATA;
  }
  
  const buffer = Buffer.alloc(16);
  const prefix = Buffer.from([0x09]);
  const instructionData = Buffer.concat([prefix, buffer]);
  const accountMetas = [
    { pubkey: account1, isSigner: false, isWritable: false },
    { pubkey: account2, isSigner: false, isWritable: true },
    { pubkey: account3, isSigner: false, isWritable: false },
    { pubkey: account4, isSigner: false, isWritable: true },
    { pubkey: account5, isSigner: false, isWritable: true },
    { pubkey: account6, isSigner: false, isWritable: true },
    { pubkey: account7, isSigner: false, isWritable: true },
    { pubkey: account8, isSigner: false, isWritable: false },
    { pubkey: account9, isSigner: false, isWritable: true },
    { pubkey: account10, isSigner: false, isWritable: true },
    { pubkey: account11, isSigner: false, isWritable: true },
    { pubkey: account12, isSigner: false, isWritable: true },
    { pubkey: account13, isSigner: false, isWritable: true },
    { pubkey: account14, isSigner: false, isWritable: true },
    { pubkey: account15, isSigner: false, isWritable: false },
    { pubkey: account16, isSigner: false, isWritable: true },
    { pubkey: account17, isSigner: false, isWritable: true },
    { pubkey: account18, isSigner: true, isWritable: true },
    { pubkey: account19, isSigner: false, isWritable: true }
  ];
  
  const swap = new TransactionInstruction({
    keys: accountMetas,
    programId,
    data: instructionData
  });


  let buyIxs: TransactionInstruction[] = [];
  let sellIxs: TransactionInstruction[] = [];
  
  if (reverse === false) {
    buyIxs.push(swap);
  }
  
  if (reverse === true) {
    sellIxs.push(swap);
  }
  
  return { buyIxs, sellIxs } ;
}


