import { Contract } from '@algorandfoundation/tealscript';

export class ARC54 extends Contract {
  /*
   * Sends an inner transaction to opt the contract account into an ASA.
   * The fee for the inner transaction must be covered by the caller.
   *
   * @param asa The ASA to opt in to
   */
  arc54_optIntoASA(asa: AssetReference): void {
    sendAssetTransfer({
      assetReceiver: globals.currentApplicationAddress,
      xferAsset: asa,
      assetAmount: 0,
      fee: 0,
    });
  }
}
