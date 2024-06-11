import {
  connection,
  wallet,
  walletconn,
  RayLiqPoolv4,
  tipAcct,
} from "../config";
import {
  PublicKey,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  DEFAULT_TOKEN,
  LP_MINT_ASSOCIATED_SEED,
  PROGRAMIDS,
  addLookupTableInfo,
  makeTxVersion,
} from "./clients/constants";
import {
  TOKEN_PROGRAM_ID,
  getMint,
  NATIVE_MINT,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import {
  Liquidity,
  MARKET_STATE_LAYOUT_V3,
  Token,
  TokenAmount,
  Market,
  MAINNET_PROGRAM_ID,
  LiquidityPoolKeysV4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  LiquidityStateV5,
  LIQUIDITY_STATE_LAYOUT_V4,
  LIQUIDITY_STATE_LAYOUT_V5,
} from "@raydium-io/raydium-sdk";
import { BN } from "@project-serum/anchor";
import { ammCreatePool, getWalletTokenAccount } from "./clients/raydiumUtil";
import { promises as fsPromises } from "fs";
import { loadKeypairs } from "./createKeys";
import { lookupTableProvider } from "./clients/LookupTableProvider";
//import { getRandomTipAccount } from "./clients/config";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import promptSync from "prompt-sync";
import * as spl from "@solana/spl-token";
import { IPoolKeys } from "./clients/interfaces";
import { getPoolKeys } from "./clients/poolKeysReassigned";
import path from "path";
import fs from "fs";

const prompt = promptSync();
const keyInfoPath = path.join(__dirname, "keyInfo.json");

type LiquidityPairTargetInfo = {
  baseToken: Token;
  quoteToken: Token;
  targetMarketId: PublicKey;
};

type AssociatedPoolKeys = {
  lpMint: PublicKey;
  id: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
};

export async function buyBundle() {
  const bundledTxns: VersionedTransaction[] = [];
  const keypairs: Keypair[] = loadKeypairs();

  let poolInfo: { [key: string]: any } = {};
  if (fs.existsSync(keyInfoPath)) {
    const data = fs.readFileSync(keyInfoPath, "utf-8");
    poolInfo = JSON.parse(data);
  }

  const lut = new PublicKey(poolInfo.addressLUT.toString());

  const lookupTableAccount = (await connection.getAddressLookupTable(lut))
    .value;

  if (lookupTableAccount == null) {
    console.log("Lookup table account not found!");
    process.exit(0);
  }

  // -------- step 1: ask nessesary questions for pool build --------
  const baseAddr = prompt("Token address: ") || "";
  const percentOfSupplyInput =
    prompt("% of your token balance in pool (Ex. 80): ") || "0";
  const solInPoolInput = prompt("# of SOL in LP (Ex. 10): ") || "0";
  const OpenBookID = prompt("OpenBook MarketID: ") || "";
  const jitoTipAmtInput = prompt("Jito tip in Sol (Ex. 0.01): ") || "0";
  const iterations = parseInt(
    prompt("Enter the number of iterations for bundle creation: ") || "0",
    10
  );
  const delaySeconds = parseInt(
    prompt("Enter the delay between each iteration in seconds: ") || "0",
    10
  );
  const walletbuy = parseInt(
    prompt("Enter the amount the wallet buy with(Ex. 1): ") || "0",
    0
  );
  const jitoTipAmt = parseFloat(jitoTipAmtInput) * LAMPORTS_PER_SOL;
  const percentOfSupply = parseFloat(percentOfSupplyInput);
  const solInPool = parseFloat(solInPoolInput);

  let myToken = new PublicKey(baseAddr);
  let tokenInfo = await getMint(
    connection,
    myToken,
    "finalized",
    TOKEN_PROGRAM_ID
  );

  const TokenBalance = await fetchTokenBalance(baseAddr, tokenInfo.decimals);
  const baseToken = new Token(
    TOKEN_PROGRAM_ID,
    new PublicKey(tokenInfo.address),
    tokenInfo.decimals
  ); // Token
  const quoteToken = DEFAULT_TOKEN.SOL; // SOL
  const targetMarketId = new PublicKey(OpenBookID);

  for (let i = 0; i < iterations; i++) {
    // -------- step 2: create pool txn --------
    const startTime = Math.floor(Date.now() / 1000);
    const walletTokenAccounts = await getWalletTokenAccount(
      connection,
      wallet.publicKey
    );

    const marketBufferInfo: any = await connection.getAccountInfo(
      targetMarketId
    );
    const {
      baseMint,
      quoteMint,
      baseLotSize,
      quoteLotSize,
      baseVault,
      quoteVault,
      bids,
      asks,
      eventQueue,
      requestQueue,
    } = MARKET_STATE_LAYOUT_V3.decode(marketBufferInfo.data);

    let poolKeys: any = Liquidity.getAssociatedPoolKeys({
      version: 4,
      marketVersion: 3,
      baseMint,
      quoteMint,
      baseDecimals: tokenInfo.decimals,
      quoteDecimals: 9,
      marketId: targetMarketId,
      programId: PROGRAMIDS.AmmV4,
      marketProgramId: PROGRAMIDS.OPENBOOK_MARKET,
    });
    poolKeys.marketBaseVault = baseVault;
    poolKeys.marketQuoteVault = quoteVault;
    poolKeys.marketBids = bids;
    poolKeys.marketAsks = asks;
    poolKeys.marketEventQueue = eventQueue;
    //console.log("Pool Keys:", poolKeys);

    // Ensure percentOfSupply and TokenBalance are scaled to integers if they involve decimals.
    const baseMintAmount = new BN(
      Math.floor((percentOfSupply / 100) * TokenBalance).toString()
    );

    // Ensure solInPool is scaled to an integer if it involves decimals.
    const quoteMintAmount = new BN((solInPool * Math.pow(10, 9)).toString());

    // If you need to clone the BN instances for some reason, this is correct. Otherwise, you can use baseMintAmount and quoteMintAmount directly.
    const addBaseAmount = new BN(baseMintAmount.toString());
    const addQuoteAmount = new BN(quoteMintAmount.toString());

    // Fetch LP Mint and write to json
    const associatedPoolKeys = getMarketAssociatedPoolKeys({
      baseToken,
      quoteToken,
      targetMarketId,
    });
    await writeDetailsToJsonFile(associatedPoolKeys, startTime);

    // GLOBAL BLOCKHASH
    const { blockhash } = await connection.getLatestBlockhash("finalized");

    const createPoolTxInfo = await ammCreatePool({
      startTime,
      addBaseAmount,
      addQuoteAmount,
      baseToken,
      quoteToken,
      targetMarketId,
      wallet: walletconn.payer,
      walletTokenAccounts,
    });

    if (!createPoolTxInfo) {
      return { Err: "Failed to prepare create pool transaction" };
    }

    //buy
    const { txs, poolId } = createPoolTxInfo;

    console.log("poolId ===========>", poolId.toBase58());
    const createPoolInstructions: TransactionInstruction[] = [];
    for (const itemIx of txs.innerTransactions) {
      createPoolInstructions.push(...itemIx.instructions);
    }

    const addressesMain: PublicKey[] = [];
    createPoolInstructions.forEach((ixn) => {
      ixn.keys.forEach((key) => {
        addressesMain.push(key.pubkey);
      });
    });

    const lookupTablesMain =
      lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain);

    const messageMain = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: createPoolInstructions,
    }).compileToV0Message(lookupTablesMain);
    const txPool = new VersionedTransaction(messageMain);
    txPool.sign([wallet]);
    // --Tip tx

    const _tipAccount = (await searcherClient.getTipAccounts())[0];
    console.log("tip account:", _tipAccount);
    const tipAccount = new PublicKey(_tipAccount);

    const tipSwapIxn = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: tipAccount,
      lamports: BigInt(jitoTipAmt),
    });
    console.log("Jito tip added :).");

    const messageTip = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipSwapIxn],
    }).compileToV0Message(lookupTablesMain);

    const TipTx = new VersionedTransaction(messageTip);
    TipTx.sign([wallet]);

    // -------- step 3: create swap txns --------
    const txMainSwaps: VersionedTransaction[] = await createWalletSwaps(
      walletbuy,
      targetMarketId,
      blockhash,
      keypairs,
      jitoTipAmt,
      lookupTableAccount
    );
    console.log("PoolTx ===>", await connection.simulateTransaction(txPool));
    console.log("TipTx ===>", await connection.simulateTransaction(TipTx));

    await sendBundled(txPool, txMainSwaps, TipTx);

    // Delay between iterations
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    bundledTxns.length = 0;
  }

  return;
}

async function createWalletSwaps(
  walletbuy: number,
  targetMarketId: PublicKey,
  blockhash: string,
  keypairs: Keypair[],
  jitoTip: number,
  lut: AddressLookupTableAccount
): Promise<VersionedTransaction[]> {
  const txsSigned: VersionedTransaction[] = [];
  const chunkedKeypairs = chunkArray(keypairs, 7); // EDIT CHUNKS?
  const keys = await getPoolKeys(targetMarketId);

  // Iterate over each chunk of keypairs
  for (let chunkIndex = 0; chunkIndex < chunkedKeypairs.length; chunkIndex++) {
    const chunk = chunkedKeypairs[chunkIndex];
    const instructionsForChunk: TransactionInstruction[] = [];

    // Iterate over each keypair in the chunk to create swap instructions
    for (let i = 0; i < chunk.length; i++) {
      const keypair = chunk[i];
      console.log(
        `Processing keypair ${i + 1}/${chunk.length}:`,
        keypair.publicKey.toString()
      );

      if (keys == null) {
        console.log("Error fetching poolkeys");
        process.exit(0);
      }

      const TokenATA = getAssociatedTokenAddressSync(
        new PublicKey(keys.baseMint),
        keypair.publicKey
      );

      const wSolATA = getAssociatedTokenAddressSync(
        spl.NATIVE_MINT,
        keypair.publicKey
      );

      const { ixs } = makeBuy(walletbuy, keys, wSolATA, TokenATA, keypair); //  CHANGE FOR SELL (sellIxs/true)

      instructionsForChunk.push(...ixs); // CHANGE FOR SELL (sellIxs)
    }

    // ALWAYS SIGN WITH THE FIRST WALLET
    const keypair = chunk[0];

    const message = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: instructionsForChunk,
    }).compileToV0Message([lut]);

    const versionedTx = new VersionedTransaction(message);

    const serializedMsg = versionedTx.serialize();
    console.log("Txn size:", serializedMsg.length);
    if (serializedMsg.length > 1232) {
      console.log("tx too big");
    }

    console.log(
      "Signing transaction with chunk signers",
      chunk.map((kp) => kp.publicKey.toString())
    );

    for (const keypair of chunk) {
      versionedTx.sign([keypair]);
    }
    console.log(
      "BuyTx ===>",
      await connection.simulateTransaction(versionedTx)
    );

    txsSigned.push(versionedTx);
  }

  return txsSigned;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (v, i) =>
    array.slice(i * size, i * size + size)
  );
}

export async function sendBundled(
  txPool: VersionedTransaction,
  txMainSwaps: VersionedTransaction[],
  TipTx: VersionedTransaction
) {
  const bundledTxns: VersionedTransaction[] = [];
  bundledTxns.push(txPool);
  bundledTxns.push(...txMainSwaps);
  bundledTxns.push(TipTx);
  try {
    const bundleId = await searcherClient.sendBundle(
      new JitoBundle(bundledTxns, bundledTxns.length)
    );
    console.log(`Bundle ${bundleId} sent.`);
  } catch (error) {
    const err = error as any;
    console.error("Error sending bundle:", err.message);

    if (err?.message?.includes("Bundle Dropped, no connected leader up soon")) {
      console.error(
        "Error sending bundle: Bundle Dropped, no connected leader up soon."
      );
    } else {
      console.error("An unexpected error occurred:", err.message);
    }
  }
}

export async function sendBundle(bundledTxns: VersionedTransaction[]) {
  try {
    const bundleId = await searcherClient.sendBundle(
      new JitoBundle(bundledTxns, bundledTxns.length)
    );
    console.log(`Bundle ${bundleId} sent.`);
  } catch (error) {
    const err = error as any;
    console.error("Error sending bundle:", err.message);

    if (err?.message?.includes("Bundle Dropped, no connected leader up soon")) {
      console.error(
        "Error sending bundle: Bundle Dropped, no connected leader up soon."
      );
    } else {
      console.error("An unexpected error occurred:", err.message);
    }
  }
}

async function fetchTokenBalance(TokenPubKey: string, decimalsToken: number) {
  const ownerPubKey = wallet.publicKey;

  const response = await connection.getParsedTokenAccountsByOwner(ownerPubKey, {
    mint: new PublicKey(TokenPubKey),
  });

  let TokenBalance = 0;
  for (const account of response.value) {
    const amount = account.account.data.parsed.info.tokenAmount.uiAmount;
    TokenBalance += amount;
  }

  return TokenBalance * 10 ** decimalsToken;
}

function makeBuy(
  walletbuy: number,
  poolKeys: LiquidityPoolKeysV4,
  wSolATA: PublicKey,
  TokenATA: PublicKey,
  keypair: Keypair
) {
  let cacheIxs = [];
  const quoteAmount = new TokenAmount(Token.WSOL, walletbuy.toString(), false);
  const inToken = (quoteAmount as TokenAmount).token.mint;
  if (inToken.toBase58() == NATIVE_MINT.toBase58()) {
    let lamports = BigInt(quoteAmount.raw.toNumber());
    const createAcc = createAssociatedTokenAccountInstruction(
      keypair.publicKey,
      wSolATA,
      keypair.publicKey,
      NATIVE_MINT
    );
    const createAccSpl = createAssociatedTokenAccountInstruction(
      keypair.publicKey,
      TokenATA,
      keypair.publicKey,
      poolKeys.baseMint
    );
    const sendSolIx = SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: wSolATA,
      lamports,
    });
    const syncWSolAta = createSyncNativeInstruction(wSolATA, TOKEN_PROGRAM_ID);
    cacheIxs.push(createAcc, createAccSpl, sendSolIx, syncWSolAta);
  }
  let rayIxs = Liquidity.makeSwapInstruction({
    poolKeys,
    amountIn: quoteAmount.raw,
    amountOut: 0,
    fixedSide: "in",
    userKeys: {
      owner: keypair.publicKey,
      tokenAccountIn: wSolATA,
      tokenAccountOut: TokenATA,
    },
  }).innerTransaction;

  return {
    ixs: [...cacheIxs, ...rayIxs.instructions],
    signer: keypair,
  };
}

function getMarketAssociatedPoolKeys(input: LiquidityPairTargetInfo) {
  const poolInfo = Liquidity.getAssociatedPoolKeys({
    version: 4,
    marketVersion: 3,
    baseMint: input.baseToken.mint,
    quoteMint: input.quoteToken.mint,
    baseDecimals: input.baseToken.decimals,
    quoteDecimals: input.quoteToken.decimals,
    marketId: input.targetMarketId,
    programId: PROGRAMIDS.AmmV4,
    marketProgramId: MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
  });
  return poolInfo;
}

async function writeDetailsToJsonFile(
  associatedPoolKeys: AssociatedPoolKeys,
  startTime: number
) {
  const filePath = path.join(__dirname, "keyInfo.json");

  try {
    // Read the current contents of the file
    let fileData = {};
    try {
      const currentData = await fsPromises.readFile(filePath, "utf-8");
      fileData = JSON.parse(currentData);
    } catch (error) {
      console.log(
        "poolinfo.json doesn't exist or is empty. Creating a new one."
      );
    }

    // Update only the specific fields related to the new pool
    const updatedData = {
      ...fileData, // Spread existing data to preserve it
      lpTokenAddr: associatedPoolKeys.lpMint.toString(),
      targetPool: associatedPoolKeys.id.toString(),
      baseMint: associatedPoolKeys.baseMint.toString(),
      quoteMint: associatedPoolKeys.quoteMint.toString(),
      openTime: new Date(startTime * 1000).toISOString(),
    };

    // Write the updated data back to the file
    await fsPromises.writeFile(
      filePath,
      JSON.stringify(updatedData, null, 2),
      "utf8"
    );
    console.log("Successfully updated the JSON file with new pool details.");
  } catch (error) {
    console.error("Failed to write to the JSON file:", error);
  }
}
