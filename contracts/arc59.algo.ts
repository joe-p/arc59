/* eslint-disable max-classes-per-file */

// eslint-disable-next-line import/no-unresolved, import/extensions
import { Contract } from '@algorandfoundation/tealscript';

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
  vaults = BoxMap<Address, Address>();

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
   * Gets an existing or create a vault for the given address
   */
  private getOrCreateVault(addr: Address): Address {
    if (this.vaults(addr).exists) return this.vaults(addr).value;

    const vault = sendMethodCall<typeof ControlledAddress.prototype.new>({
      onCompletion: OnCompletion.DeleteApplication,
      approvalProgram: ControlledAddress.approvalProgram(),
      clearStateProgram: ControlledAddress.clearProgram(),
    });

    this.vaults(addr).value = vault;

    return vault;
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

    if (!this.vaults(receiver).exists) {
      // Two itxns to create vault (create + rekey)
      // One itxns to send MBR
      // One itxn to opt in
      info.itxns += 4;

      // Calculate the MBR for the vault box
      const preMBR = globals.currentApplicationAddress.minBalance;
      this.vaults(receiver).value = globals.zeroAddress;
      const boxMbrDelta = globals.currentApplicationAddress.minBalance - preMBR;
      this.vaults(receiver).delete();

      // MBR = MBR for the box + min balance for the vault + ASA MBR
      info.mbr = boxMbrDelta + globals.minBalance + globals.assetOptInMinBalance;

      return info;
    }

    const vault = this.vaults(receiver).value;

    if (!vault.isOptedInToAsset(asset)) {
      // One itxn to opt in
      info.itxns += 1;

      if (!(vault.balance >= vault.minBalance + globals.assetOptInMinBalance)) {
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
   * @returns The address that the asset was sent to (either the receiver or their vault)
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

    const vaultExisted = this.vaults(receiver).exists;
    const vault = this.getOrCreateVault(receiver);

    if (!vault.isOptedInToAsset(axfer.xferAsset)) {
      let vaultMbrDelta = globals.assetOptInMinBalance;
      if (!vaultExisted) vaultMbrDelta += globals.minBalance;

      // Ensure the vault has enough balance to opt in
      if (vault.balance < vault.minBalance + vaultMbrDelta) {
        sendPayment({
          receiver: vault,
          amount: vaultMbrDelta,
        });
      }

      // Opt the vault in
      sendAssetTransfer({
        sender: vault,
        assetReceiver: vault,
        assetAmount: 0,
        xferAsset: axfer.xferAsset,
      });
    }

    // Transfer the asset to the vault
    sendAssetTransfer({
      assetReceiver: vault,
      assetAmount: axfer.assetAmount,
      xferAsset: axfer.xferAsset,
    });

    return vault;
  }

  /**
   * Claim an ASA from the vault
   *
   * @param asa The ASA to claim
   */
  arc59_claim(asa: AssetID): void {
    const vault = this.vaults(this.txn.sender).value;

    const preMBR = vault.minBalance;

    sendAssetTransfer({
      sender: vault,
      assetReceiver: this.txn.sender,
      assetAmount: vault.assetBalance(asa),
      xferAsset: asa,
      assetCloseTo: this.txn.sender,
    });

    sendPayment({
      sender: vault,
      receiver: this.txn.sender,
      amount: preMBR - vault.minBalance,
    });
  }

  /**
   * Burn the ASA from the vault with ARC54
   *
   * @param asa The ASA to burn
   * @param arc54App The ARC54 app to burn the ASA to
   */
  arc59_burn(asa: AssetID, arc54App: AppID) {
    const vault = this.vaults(this.txn.sender).value;

    // opt the arc54 app into the ASA if not already opted in
    if (!arc54App.address.isOptedInToAsset(asa)) {
      sendPayment({
        receiver: arc54App.address,
        amount: globals.assetOptInMinBalance,
      });

      sendMethodCall<[AssetReference], void>({
        sender: vault,
        name: 'arc54_optIntoASA',
        methodArgs: [asa],
        applicationID: arc54App,
      });
    }

    const preMBR = vault.minBalance;

    sendAssetTransfer({
      sender: vault,
      assetReceiver: arc54App.address,
      assetAmount: vault.assetBalance(asa),
      xferAsset: asa,
      assetCloseTo: arc54App.address,
    });

    sendPayment({
      sender: vault,
      receiver: this.txn.sender,
      amount: preMBR - vault.minBalance,
    });
  }
}
