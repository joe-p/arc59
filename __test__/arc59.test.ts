import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import * as algokit from '@algorandfoundation/algokit-utils';
import algosdk from 'algosdk';
import { Arc59Client } from '../contracts/clients/Arc59Client';
import { Arc54Client } from '../contracts/clients/ARC54Client';

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
  const arc59RouterAddress = (await appClient.appClient.getAppReference()).appAddress;

  const sendInfo = (await appClient.arc59GetAssetSendInfo({ asset: assetId, receiver })).return;

  const itxns = sendInfo![0];
  const mbr = sendInfo![1];

  const composer = appClient.compose();

  const suggestedParams = await algod.getTransactionParams().do();

  if (mbr) {
    const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: sender,
      to: arc59RouterAddress,
      amount: mbr,
      suggestedParams,
    });

    composer.addTransaction({ transaction: mbrPayment, signer });
  }

  const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    from: sender,
    to: arc59RouterAddress,
    assetIndex: assetId,
    amount: 1,
    suggestedParams,
  });

  // If the router is not opted in, call arc59OptRouterIn to do so
  try {
    // accountAssetInformation throws an error if the account is not opted in
    await algod.accountAssetInformation(arc59RouterAddress, assetId).do();
  } catch (e) {
    const fundRouterTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: sender,
      to: arc59RouterAddress,
      amount: 200_000,
      suggestedParams: { ...suggestedParams, fee: 2_000, flatFee: true },
    });
    composer.addTransaction({ transaction: fundRouterTxn, signer });
    composer.arc59OptRouterIn({ asa: assetId });
  }

  await composer
    .arc59SendAsset({ axfer, receiver }, { sendParams: { fee: algokit.microAlgos(1000 + 1000 * Number(itxns)) } })
    .execute();
}

describe('Arc59', () => {
  let appClient: Arc59Client;
  let assetOne: number;
  let assetTwo: number;
  let alice: algosdk.Account;
  let bob: algosdk.Account;
  let arc54Client: Arc54Client;
  let arc54id: number;

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

    const assetOneCreate = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
      from: testAccount.addr,
      unitName: 'one',
      total: 100,
      decimals: 0,
      defaultFrozen: false,
      suggestedParams: await algod.getTransactionParams().do(),
    });
    const atc = new algosdk.AtomicTransactionComposer();
    atc.addTransaction({ txn: assetOneCreate, signer: algosdk.makeBasicAccountTransactionSigner(testAccount) });
    const oneResult = await algokit.sendAtomicTransactionComposer({ atc }, algod);
    assetOne = Number(oneResult.confirmations![0].assetIndex);

    const assetTwoCreate = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
      from: testAccount.addr,
      unitName: 'two',
      total: 100,
      decimals: 0,
      defaultFrozen: false,
      suggestedParams: await algod.getTransactionParams().do(),
    });
    const atcTwo = new algosdk.AtomicTransactionComposer();
    atcTwo.addTransaction({ txn: assetTwoCreate, signer: algosdk.makeBasicAccountTransactionSigner(testAccount) });
    const twoResult = await algokit.sendAtomicTransactionComposer({ atc: atcTwo }, algod);
    assetTwo = Number(twoResult.confirmations![0].assetIndex);

    alice = testAccount;

    arc54Client = new Arc54Client(
      {
        sender: testAccount,
        resolveBy: 'id',
        id: 0,
      },
      algod
    );

    const result = await arc54Client.create.createApplication({});
    await arc54Client.appClient.fundAppAccount(algokit.microAlgos(100_000));
    arc54id = Number(result.appId);

    await appClient.create.createApplication({ burnApp: arc54id });

    await appClient.appClient.fundAppAccount({ amount: algokit.microAlgos(200_000) });
  });

  test('routerOptIn', async () => {
    await appClient.arc59OptRouterIn({ asa: assetOne }, { sendParams: { fee: algokit.microAlgos(2_000) } });
  });

  test('Brand new account getAssetSendInfo', async () => {
    const res = await appClient.arc59GetAssetSendInfo({ asset: assetOne, receiver: algosdk.generateAccount().addr });

    const itxns = res.return![0];
    const mbr = res.return![1];

    expect(itxns).toBe(5n);
    expect(mbr).toBe(228_100n);
  });

  test('Brand new account sendAsset', async () => {
    const { algod, testAccount } = fixture.context;
    bob = testAccount;

    await sendAsset(appClient, assetOne, alice.addr, alice, bob.addr, algod);
  });

  test('Existing inbox sendAsset (existing asset)', async () => {
    const { algod } = fixture.context;

    await sendAsset(appClient, assetOne, alice.addr, alice, bob.addr, algod);
  });

  test('Existing inbox sendAsset (new asset)', async () => {
    const { algod } = fixture.context;

    await sendAsset(appClient, assetTwo, alice.addr, alice, bob.addr, algod);
  });

  test('claim', async () => {
    const { algod } = fixture.context;

    await algokit.assetOptIn({ assetId: assetOne, account: bob }, algod);
    await appClient.arc59Claim({ asa: assetOne }, { sender: bob, sendParams: { fee: algokit.algos(0.003) } });

    const bobAssetInfo = await algod.accountAssetInformation(bob.addr, assetOne).do();

    expect(bobAssetInfo['asset-holding'].amount).toBe(2);
  });

  test('burn', async () => {
    await appClient.arc59Burn({ asa: assetTwo }, { sender: bob, sendParams: { fee: algokit.algos(0.006) } });
  });
});
