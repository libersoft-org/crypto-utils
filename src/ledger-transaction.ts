import { get } from "svelte/store";
import { Contract, Transaction } from "ethers";
import type { IAddress, IWallet } from "./wallet";
import { provider } from "./provider";
import { selectedNetwork } from "./network";
import { signEthereumTransaction } from "./ledger";
import type { TransactionResponse } from "ethers";
import {
	assertUsableFeeParams,
	type ITransactionFeeParams,
} from "./fee-params";
// ensureLedgerState should be called by UI component before calling sendTransactionLedger

export async function sendTransactionLedger(
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

	// Ensure Ledger state is available
	// ensureLedgerState should be called by UI component before this function

	// Get provider for nonce and gas estimation
	const providerInstance = get(provider);
	if (!providerInstance) {
		throw new Error("No provider available");
	}

	const network = get(selectedNetwork);
	if (!network) {
		throw new Error("No network selected");
	}

	console.log("Preparing Ledger transaction...");
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
	 * The previous hardcoded 65000 for any token transfer was a guess that fails on contracts doing
	 * more than a plain balance move - and the user still paid for the failed attempt. */
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

	// Prepare transaction parameters for Ledger
	const txParams: any = {
		to: contractAddress || dstAddress,
		value: contractAddress ? 0n : amount, // Use bigint directly
		gasLimit: feeParams.gasLimit,
		nonce: nonce,
		chainId: network.chainID,
		data: txData || "0x",
	};

	/* Exactly the confirmed pricing - no re-reading of getFeeData(), and no "reasonable default"
	 * that the user never saw. */
	if (feeParams.maxFeePerGas !== undefined) {
		// EIP-1559 transaction (type 2) - modern gas pricing
		txParams.type = 2;
		txParams.maxFeePerGas = feeParams.maxFeePerGas;
		txParams.maxPriorityFeePerGas =
			feeParams.maxPriorityFeePerGas ?? feeParams.maxFeePerGas;
	} else {
		// Legacy transaction - don't set the type field, ethers.js handles it
		txParams.gasPrice = feeParams.gasPrice;
	}

	console.log("Transaction type:", txParams.type || "legacy (no type field)");

	// Sign transaction with Ledger
	console.log("Signing transaction with Ledger...");
	const signResult = await signEthereumTransaction(srcAddress.path, txParams);

	if (!signResult.success) {
		const errorMessage = signResult.error || "Transaction signing failed";
		console.error("Ledger transaction signing failed:", errorMessage);
		throw new Error(`Ledger signing failed: ${errorMessage}`);
	}

	console.log("Ledger signing result:", signResult);

	// Reconstruct the signed transaction using ethers Transaction class
	const signature = signResult.payload;

	// Create transaction object with signature
	const signedTxData = {
		...txParams,
		signature: {
			r: signature.r,
			s: signature.s,
			v: signature.v,
		},
	};

	// Use ethers to serialize the signed transaction
	const tx = Transaction.from(signedTxData);
	const serializedTx = tx.serialized;

	console.log("Broadcasting signed transaction...");

	try {
		const txResponse =
			await providerInstance.broadcastTransaction(serializedTx);
		console.log("Transaction broadcast successful:", txResponse.hash);
		return txResponse;
	} catch (broadcastError) {
		console.error("Failed to broadcast transaction:", broadcastError);
		throw new Error(
			`Failed to broadcast transaction: ${broadcastError instanceof Error ? broadcastError.message : "Unknown error"}`,
		);
	}
}
