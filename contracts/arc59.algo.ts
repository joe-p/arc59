/* eslint-disable max-classes-per-file */

// eslint-disable-next-line import/no-unresolved, import/extensions
import { Contract } from '@algorandfoundation/tealscript';
import { ARC54 } from './arc54.algo';

class ControlledAddress extends Contract {
  @allow.create('DeleteApplication')
  new(): Address {
    sendPayment({
      rekeyTo: this.txn.sender,
    });

    return this.app.address;
  }
}

export class ARC59 extends Contract {
  inboxes = BoxMap<Address, Address>();

  /**
   * Opt the ARC59 router into the ASA. This is required before this app can be used to send the ASA to anyone.
   *
   * @param asa The ASA to opt into
   */
  arc59_optRouterIn(asa: AssetID): void {
    sendAssetTransfer({
      assetReceiver: this.app.address,
      assetAmount: 0,
      xferAsset: asa,
    });
  }

  /**
   * Gets an existing or create a inbox for the given address
   */
  private getOrCreateInbox(addr: Address): Address {
    if (this.inboxes(addr).exists) return this.inboxes(addr).value;

    const inbox = sendMethodCall<typeof ControlledAddress.prototype.new>({
      onCompletion: OnCompletion.DeleteApplication,
      approvalProgram: ControlledAddress.approvalProgram(),
      clearStateProgram: ControlledAddress.clearProgram(),
    });

    this.inboxes(addr).value = inbox;

    return inbox;
  }

  /**
   *
   * @param receiver The address to send the asset to
   * @param asset The asset to send
   *
   * @returns The number of itxns sent and the MBR required to send the asset to the receiver
   */
  arc59_getAssetSendInfo(receiver: Address, asset: AssetID): { itxns: uint64; mbr: uint64 } {
    const info: { itxns: uint64; mbr: uint64 } = { itxns: 1, mbr: 0 };

    if (receiver.isOptedInToAsset(asset)) return info;

    if (!this.inboxes(receiver).exists) {
      // Two itxns to create inbox (create + rekey)
      // One itxns to send MBR
      // One itxn to opt in
      info.itxns += 4;

      // Calculate the MBR for the inbox box
      const preMBR = globals.currentApplicationAddress.minBalance;
      this.inboxes(receiver).value = globals.zeroAddress;
      const boxMbrDelta = globals.currentApplicationAddress.minBalance - preMBR;
      this.inboxes(receiver).delete();

      // MBR = MBR for the box + min balance for the inbox + ASA MBR
      info.mbr = boxMbrDelta + globals.minBalance + globals.assetOptInMinBalance;

      return info;
    }

    const inbox = this.inboxes(receiver).value;

    if (!inbox.isOptedInToAsset(asset)) {
      // One itxn to opt in
      info.itxns += 1;

      if (!(inbox.balance >= inbox.minBalance + globals.assetOptInMinBalance)) {
        // One itxn to send MBR
        info.itxns += 1;

        // MBR = ASA MBR
        info.mbr = globals.assetOptInMinBalance;
      }
    }

    return info;
  }

  /**
   * Send an asset to the receiver
   *
   * @param receiver The address to send the asset to
   * @param axfer The asset transfer to this app
   *
   * @returns The address that the asset was sent to (either the receiver or their inbox)
   */
  arc59_sendAsset(axfer: AssetTransferTxn, receiver: Address): Address {
    verifyAssetTransferTxn(axfer, {
      assetReceiver: this.app.address,
    });

    // If the receiver is opted in, send directly to their account
    if (receiver.isOptedInToAsset(axfer.xferAsset)) {
      sendAssetTransfer({
        assetReceiver: receiver,
        assetAmount: axfer.assetAmount,
        xferAsset: axfer.xferAsset,
      });

      return receiver;
    }

    const inboxExisted = this.inboxes(receiver).exists;
    const inbox = this.getOrCreateInbox(receiver);

    if (!inbox.isOptedInToAsset(axfer.xferAsset)) {
      let inboxMbrDelta = globals.assetOptInMinBalance;
      if (!inboxExisted) inboxMbrDelta += globals.minBalance;

      // Ensure the inbox has enough balance to opt in
      if (inbox.balance < inbox.minBalance + inboxMbrDelta) {
        sendPayment({
          receiver: inbox,
          amount: inboxMbrDelta,
        });
      }

      // Opt the inbox in
      sendAssetTransfer({
        sender: inbox,
        assetReceiver: inbox,
        assetAmount: 0,
        xferAsset: axfer.xferAsset,
      });
    }

    // Transfer the asset to the inbox
    sendAssetTransfer({
      assetReceiver: inbox,
      assetAmount: axfer.assetAmount,
      xferAsset: axfer.xferAsset,
    });

    return inbox;
  }

  /**
   * Claim an ASA from the inbox
   *
   * @param asa The ASA to claim
   */
  arc59_claim(asa: AssetID): void {
    const inbox = this.inboxes(this.txn.sender).value;

    const preMBR = inbox.minBalance;

    sendAssetTransfer({
      sender: inbox,
      assetReceiver: this.txn.sender,
      assetAmount: inbox.assetBalance(asa),
      xferAsset: asa,
      assetCloseTo: this.txn.sender,
    });

    sendPayment({
      sender: inbox,
      receiver: this.txn.sender,
      amount: preMBR - inbox.minBalance,
    });
  }

  /**
   * Burn the ASA from the inbox with ARC54
   *
   * @param asa The ASA to burn
   * @param arc54App The ARC54 app to burn the ASA to
   */
  arc59_burn(asa: AssetID, arc54App: AppID) {
    const inbox = this.inboxes(this.txn.sender).value;
    const arc54OptedIn = arc54App.address.isOptedInToAsset(asa);

    // opt the arc54 app into the ASA if not already opted in
    if (!arc54OptedIn) {
      sendPayment({
        sender: inbox,
        receiver: arc54App.address,
        amount: globals.assetOptInMinBalance,
      });

      sendMethodCall<typeof ARC54.prototype.arc54_optIntoASA>({
        sender: inbox,
        methodArgs: [asa],
        applicationID: arc54App,
      });
    }

    const preMBR = inbox.minBalance;

    sendAssetTransfer({
      sender: inbox,
      assetReceiver: arc54App.address,
      assetAmount: inbox.assetBalance(asa),
      xferAsset: asa,
      assetCloseTo: arc54App.address,
    });

    /**
     * Probably unecessary, but track the MBR delta after opt out incase it differs from globals.assetOptInMinBalance.
     * I imagine even with future MBR changes this wouldn't be a problem, but rather be extra safe here
     */
    const optOutAmount = preMBR - inbox.minBalance;

    sendPayment({
      sender: inbox,
      receiver: this.txn.sender,
      amount: arc54OptedIn ? optOutAmount : optOutAmount - globals.assetOptInMinBalance,
    });
  }
}
