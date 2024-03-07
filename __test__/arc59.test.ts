import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import * as algokit from '@algorandfoundation/algokit-utils';
import algosdk from 'algosdk';
import { Arc59Client } from '../contracts/clients/Arc59Client';

const fixture = algorandFixture();
algokit.Config.configure({ populateAppCallResources: true });

async function sendAsset(
  appClient: Arc59Client,
  assetId: number,
  sender: string,
  signer: algosdk.Account,
  receiver: string,
  algod: algosdk.Algodv2
) {
  const arc12RouterAddress = (await appClient.appClient.getAppReference()).appAddress;

  const sendInfo = (await appClient.getAssetSendInfo({ asset: assetId, receiver })).return;

  const itxns = sendInfo![0];
  const mbr = sendInfo![1];

  const composer = appClient.compose();

  if (mbr) {
    const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: sender,
      to: arc12RouterAddress,
      amount: mbr,
      suggestedParams: await algod.getTransactionParams().do(),
    });

    composer.addTransaction({ transaction: mbrPayment, signer });
  }

  const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    from: sender,
    to: arc12RouterAddress,
    assetIndex: assetId,
    amount: 1,
    suggestedParams: await algod.getTransactionParams().do(),
  });

  await composer
    .sendAsset({ axfer, receiver }, { sendParams: { fee: algokit.microAlgos(1000 + 1000 * Number(itxns)) } })
    .execute();
}

describe('Arc12', () => {
  let appClient: Arc59Client;
  let assetId: number;
  let alice: algosdk.Account;

  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { algod, testAccount } = fixture.context;

    appClient = new Arc59Client(
      {
        sender: testAccount,
        resolveBy: 'id',
        id: 0,
      },
      algod
    );

    const assetCreate = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
      from: testAccount.addr,
      total: 100,
      decimals: 0,
      defaultFrozen: false,
      suggestedParams: await algod.getTransactionParams().do(),
    });

    const atc = new algosdk.AtomicTransactionComposer();

    atc.addTransaction({ txn: assetCreate, signer: algosdk.makeBasicAccountTransactionSigner(testAccount) });

    const result = await algokit.sendAtomicTransactionComposer({ atc }, algod);

    assetId = Number(result.confirmations![0].assetIndex);
    await appClient.create.createApplication({});

    await appClient.appClient.fundAppAccount({ amount: algokit.microAlgos(200_000) });

    alice = testAccount;
  });

  test('routerOptIn', async () => {
    await appClient.optRouterIn({ asa: assetId }, { sendParams: { fee: algokit.microAlgos(2_000) } });
  });

  test('Brand new account getAssetSendInfo', async () => {
    const res = await appClient.getAssetSendInfo({ asset: assetId, receiver: algosdk.generateAccount().addr });

    const itxns = res.return![0];
    const mbr = res.return![1];

    expect(itxns).toBe(5n);
    expect(mbr).toBe(228_100n);
  });

  test('Brand new account sendAsset', async () => {
    const { algod } = fixture.context;
    const bob = algosdk.generateAccount();

    await sendAsset(appClient, assetId, alice.addr, alice, bob.addr, algod);
  });
});
