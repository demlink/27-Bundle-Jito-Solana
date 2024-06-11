import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

export interface IPoolKeys {
  keg?: PublicKey;
  version?: number;
  marketVersion: number;
  programId: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  ownerBaseAta: PublicKey;
  ownerQuoteAta: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  lpDecimals: number;
  authority: PublicKey;
  marketAuthority: PublicKey;
  marketProgramId: PublicKey;
  marketId: PublicKey;
  marketBids: any;
  marketAsks: any;
  marketQuoteVault: any;
  marketBaseVault: any;
  marketEventQueue: any;
  id: any;
  baseVault: any;
  coinVault?: PublicKey;
  lpMint: PublicKey;
  lpVault: PublicKey;
  targetOrders: any;
  withdrawQueue: PublicKey;
  openOrders: any;
  quoteVault: any;
  lookupTableAccount?: PublicKey;
}

export interface ISwpBaseIn {
  swapBaseIn?: {
    amountIn?: BN;
    minimumAmountOut?: BN;
  };
}
