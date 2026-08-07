import { get } from "svelte/store";
import { Contract } from "ethers";
import TrezorConnect from "@trezor/connect-web";
import type { IAddress, IWallet } from "./wallet";
// ensureTrezorState should be called by UI component before calling sendTransactionTrezor
import { provider } from "./provider";
import { selectedNetwork } from "./network";
import { withTrezorState, withTimeout } from "./trezor";
import type { TransactionResponse } from "ethers";
import {
	assertUsableFeeParams,
	type ITransactionFeeParams,
} from "./fee-params";

export async function sendTransactionTrezor(
	wallet: IWallet,
	srcAddress: IAddress,
	dstAddress: string,
	amount: bigint,
	feeParams: ITransactionFeeParams,
	contractAddress?: string,
): Promise<TransactionResponse> {
	// Validate inputs
	if (!wallet || !srcAddress || !dstAddress || amount <= 0n) {
		throw new Error("Invalid transaction parameters");
	}
	/* Sign the fee the user confirmed, not whatever the node reports now. */
	assertUsableFeeParams(feeParams);

	// Ensure Trezor state is available
	// ensureTrezorState should be called by UI component before this function

	return await withTrezorState(async (): Promise<TransactionResponse> => {
		// Get provider for nonce and gas estimation
		const providerInstance = get(provider);
		if (!providerInstance) {
			throw new Error("No provider available");
		}

		const network = get(selectedNetwork);
		if (!network) {
			throw new Error("No network selected");
		}

		console.log("Preparing Trezor transaction...");
		console.log("From:", srcAddress.address);
		console.log("To:", dstAddress);
		console.log("Amount:", amount.toString());
		console.log("Gas limit:", feeParams.gasLimit.toString());
		console.log("Contract:", contractAddress || "ETH");

		// Get transaction count (nonce)
		const nonce = await providerInstance.getTransactionCount(
			srcAddress.address,
			"pending",
		);
		console.log("Transaction nonce:", nonce);

		/* Gas limit comes from the confirmed parameters, estimated against this very transaction.
		 * The previous hardcoded 65000 for any token transfer was a guess that fails on contracts
		 * doing more than a plain balance move - and the user still paid for the failed attempt. */
		const gasLimit = "0x" + feeParams.gasLimit.toString(16);
		let txData: string | undefined;

		if (contractAddress) {
			// Encode transfer function call data
			const tokenInterface = new Contract(contractAddress, [
				"function transfer(address to, uint256 amount) returns (bool)",
			]);
			txData = tokenInterface.interface.encodeFunctionData("transfer", [
				dstAddress,
				amount,
			]);
		}

		// Prepare transaction parameters for Trezor
		const txParams: any = {
			to: contractAddress || dstAddress,
			value: contractAddress ? "0x0" : "0x" + amount.toString(16),
			gasLimit: gasLimit,
			nonce: "0x" + nonce.toString(16),
			chainId: network.chainID,
		};

		// Add transaction data for token transfers
		if (txData) {
			txParams.data = txData;
		}

		// Use EIP-1559 transaction if the confirmed parameters are of that shape
		if (feeParams.maxFeePerGas !== undefined) {
			txParams.maxFeePerGas = "0x" + feeParams.maxFeePerGas.toString(16);
			txParams.maxPriorityFeePerGas =
				"0x" +
				(feeParams.maxPriorityFeePerGas ?? feeParams.maxFeePerGas).toString(16);
		} else if (feeParams.gasPrice !== undefined) {
			txParams.gasPrice = "0x" + feeParams.gasPrice.toString(16);
		}

		console.log("Trezor transaction parameters:", txParams);

		// Sign transaction with Trezor
		const result = await withTimeout(
			TrezorConnect.ethereumSignTransaction({
				path: srcAddress.path,
				transaction: txParams,
				device: {
					path: wallet.identifiers?.path,
					state: wallet.identifiers?.staticSessionId,
				},
			}),
			160000,
		);

		console.log("Trezor signing result:", result);

		if (!result.success) {
			const errorMessage =
				result.payload?.error || "Transaction signing failed";
			console.error("Trezor transaction signing failed:", errorMessage);
			throw new Error(`Trezor signing failed: ${errorMessage}`);
		}

		// Broadcast the signed transaction
		const signedTx = result.payload;
		console.log("Broadcasting signed transaction:", signedTx);

		try {
			const txResponse = await providerInstance.broadcastTransaction(
				signedTx.serializedTx,
			);
			console.log("Transaction broadcast successful:", txResponse.hash);
			return txResponse;
		} catch (broadcastError) {
			console.error("Failed to broadcast transaction:", broadcastError);
			throw new Error(
				`Failed to broadcast transaction: ${broadcastError instanceof Error ? broadcastError.message : "Unknown error"}`,
			);
		}
	});
}
