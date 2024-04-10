import algosdk from 'algosdk';
import { MutableArc59Client } from '../contracts/clients/MutableARC59Client';
import 'dotenv/config';
import * as algokit from '@algorandfoundation/algokit-utils';

async function deploy() {
  if (process.env.TESTNET_DEPLOYER_MNEMONIC === undefined) {
    throw new Error('TESTNET_DEPLOYER_MNEMONIC not set');
  }
  const deployer = algosdk.mnemonicToSecretKey(process.env.TESTNET_DEPLOYER_MNEMONIC);
  if (process.env.TESTNET_APP_ID === undefined) {
    throw new Error('TESTNET_APP_ID not set');
  }

  const id = parseInt(process.env.TESTNET_APP_ID, 10);

  const appClient = new MutableArc59Client(
    {
      sender: deployer,
      resolveBy: 'id',
      id,
    },
    algokit.getAlgoClient(algokit.getAlgoNodeConfig('testnet', 'algod'))
  );

  if (id === 0) {
    const result = await appClient.create.createApplication({});

    console.debug(`App ${result.appId} created in transaction ${result.transaction.txID()}`);
  } else {
    const result = await appClient.update.updateApplication({});
    console.debug(`App ${id} updated in transaction ${result.transaction.txID()}`);
  }
}

deploy();
