import { Keypair } from '@solana/web3.js';
import { config } from './config';
import { geyserClient as jitoGeyserClient } from 'jito-ts';
import {
  SearcherClient,
  searcherClient as jitoSearcherClient,
} from 'jito-ts/dist/sdk/block-engine/searcher.js';
import * as fs from 'fs';

const BLOCK_ENGINE_URLS = config.get('block_engine_urls');

const GEYSER_URL = config.get('geyser_url');
const GEYSER_ACCESS_TOKEN = config.get('geyser_access_token');

const decodedKey = new Uint8Array([ 170, 102, 199, 216, 226, 201, 23, 43, 26, 120, 207, 73, 110, 164, 116, 178, 255, 140, 255, 218, 189, 56, 60, 156, 217, 54, 187, 126, 163, 9, 162, 105, 7, 82, 19, 78, 31, 45, 211, 21, 169, 244, 1, 88, 110, 145, 211, 13, 133, 99, 16, 32, 105, 253, 55, 213, 94, 124, 237, 195, 235, 255, 7, 72 ]);
const keypair = Keypair.fromSecretKey(decodedKey);

export const privateKey = keypair

const searcherClients: SearcherClient[] = [];

  const client = jitoSearcherClient("tokyo.mainnet.block-engine.jito.wtf", keypair, {
    'grpc.keepalive_timeout_ms': 4000,
  });
  searcherClients.push(client);

const geyserClient = jitoGeyserClient(GEYSER_URL, GEYSER_ACCESS_TOKEN, {
  'grpc.keepalive_timeout_ms': 4000,
});

// all bundles sent get automatically forwarded to the other regions.
// assuming the first block engine in the array is the closest one
const searcherClient = searcherClients[0];

export { searcherClient, searcherClients, geyserClient };