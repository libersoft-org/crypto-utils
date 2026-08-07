import { get } from "svelte/store";
import { writable } from "svelte/store";
import {
	Mnemonic,
	HDNodeWallet,
	parseUnits,
	formatUnits,
	Contract,
	type PreparedTransactionRequest,
} from "ethers";
import { ensureProviderConnected, provider } from "./provider";
import { selectedNetwork, type INetwork } from "./network";
import { selectedWallet, selectedAddress } from "./wallet";
import { sendTransactionTrezor } from "./trezor-transaction";
import { sendTransactionLedger } from "./ledger-transaction";
import type { TransactionResponse } from "ethers";
import { addTransactionToLog } from "./log.ts";
import {
	assertUsableFeeParams,
	feeParamsFromTotal,
	feeParamsMaxCost,
	withAddressLock,
	type ITransactionFeeParams,
} from "./fee-params";
export {
	feeParamsMaxCost,
	isEip1559,
	type ITransactionFeeParams,
} from "./fee-params";

export interface IPayment {
	address: string;
	amount: bigint;
	fee: bigint;
	symbol: string | null | undefined;
	contractAddress?: string; // For tokens - undefined for native currency
}

export interface FeeEstimate {
	low: string;
	average: string;
	high: string;
}

export interface TransactionTimeEstimate {
	low: string;
	average: string;
	high: string;
}

let estimatedFee: FeeEstimate = {
	low: "0",
	average: "0",
	high: "0",
};
/** Concrete gas parameters behind each estimated level. Null until an estimate succeeds. */
let estimatedFeeParams: Record<
	"low" | "average" | "high",
	ITransactionFeeParams
> | null = null;
export let estimatedTransactionTimes = writable<TransactionTimeEstimate>({
	low: "unknown",
	average: "unknown",
	high: "unknown",
});
export const feeLoading = writable(false);
export const transactionTimeLoading = writable(false);
export const feeLevel = writable<"low" | "average" | "high" | "custom">(
	"average",
);
export const fee = writable<string | number>("0");
export const transactionTime = writable<string>("unknown");
export const avgBlockTimeStore = writable<any>();
export const confirmationBlocksStore = writable<any>();

transactionTime.subscribe((value) => {
	console.log("transactionTime updated:", value);
});

export function getEtherAmount(amount: string | number): bigint | null {
	try {
		let etherAmount: bigint = parseUnits(amount.toString(), 18); // 18 is the number of decimals for Ether
		return etherAmount;
	} catch (e) {
		return null;
	}
}

/** What the fee estimate should be computed for. Without a real recipient and amount, a token
 * transfer cannot be estimated correctly - a contract may charge very different gas depending on
 * whether the recipient already holds a balance, on fee-on-transfer logic or on allowances. */
export interface IFeeEstimateRequest {
	contractAddress?: string | undefined;
	/** Recipient of the transfer. Falls back to the sender, which is a valid transfer target. */
	to?: string | undefined;
	/** Raw amount in the token's base units (or wei for the native currency). */
	amount?: bigint | undefined;
}

/** Gas headroom over the estimate, to absorb state changes between estimating and mining. */
const GAS_LIMIT_HEADROOM_PERCENT = 120n;

/** Estimates the gas limit for the transaction that will actually be signed. */
export async function estimateGasLimit(
	request: IFeeEstimateRequest,
): Promise<bigint> {
	const providerInstance = get(provider);
	const selectedAddressValue = get(selectedAddress);
	if (!providerInstance || !selectedAddressValue) {
		throw new Error("Cannot estimate gas without a provider and an address");
	}
	const from = selectedAddressValue.address;
	/* Estimating against the sender's own address is a real, always-valid transfer. It is only a
	 * fallback for the "user has not typed a recipient yet" case - the estimate is refreshed with the
	 * real recipient before the transaction is confirmed. */
	const to = request.to && request.to.length > 0 ? request.to : from;
	if (!request.contractAddress) {
		const estimate = await providerInstance.estimateGas({
			from,
			to,
			value: request.amount ?? 0n,
		});
		return (estimate * GAS_LIMIT_HEADROOM_PERCENT) / 100n;
	}
	/* Encode the very same transfer that will be signed and let the node price it. Note this needs no
	 * wallet: eth_estimateGas is a plain RPC call against the `from` address. */
	const tokenContract = new Contract(
		request.contractAddress,
		["function transfer(address to, uint256 amount) returns (bool)"],
		providerInstance,
	);
	const data = tokenContract.interface.encodeFunctionData("transfer", [
		to,
		request.amount ?? 1n,
	]);
	const estimate = await providerInstance.estimateGas({
		from,
		to: request.contractAddress,
		data,
		value: 0n,
	});
	return (estimate * GAS_LIMIT_HEADROOM_PERCENT) / 100n;
}

export async function estimateTransactionFee(
	request: IFeeEstimateRequest = {},
): Promise<{
	low: string;
	average: string;
	high: string;
} | null> {
	const providerInstance = get(provider);
	const selectedAddressValue = get(selectedAddress);
	if (!providerInstance || !get(selectedNetwork) || !selectedAddressValue) {
		return null;
	}
	feeLoading.set(true);
	// Clear fee if not custom level
	const currentFeeLevel = get(feeLevel);
	if (currentFeeLevel !== "custom") fee.set("");
	try {
		const feeData = await providerInstance.getFeeData();
		/* No silent fallback to a hardcoded gas limit: a token whose transfer needs more gas than the
		 * guess would fail on chain and the user would still pay for the attempt. If the node cannot
		 * price the transaction, the UI has to refuse it. */
		const gasLimit = await estimateGasLimit(request);

		let maxFeePerGas = feeData.maxFeePerGas;
		let gasPrice = feeData.gasPrice;
		// Adaptive gas price multiplier based on network conditions
		let gasPriceMultiplier = 120n; // Default 120% (reduced from previous high values)
		// Check recent block congestion to adjust gas price
		try {
			const latestBlock = await providerInstance.getBlock("latest");
			if (latestBlock && latestBlock.gasUsed && latestBlock.gasLimit) {
				const gasUtilization = Number(
					(latestBlock.gasUsed * 100n) / latestBlock.gasLimit,
				);
				// Adjust multiplier based on network congestion - more conservative values
				if (gasUtilization > 95) gasPriceMultiplier = 150n;
				else if (gasUtilization > 85) gasPriceMultiplier = 140n;
				else if (gasUtilization > 70) gasPriceMultiplier = 130n;
			}
		} catch (blockError) {
			console.warn(
				"Could not check network congestion, using default gas price",
			);
		}

		/* Build the concrete parameters for each level, so that whatever the user picks is exactly
		 * what gets signed. */
		let levels: Record<"low" | "average" | "high", ITransactionFeeParams>;
		if (maxFeePerGas && feeData.maxPriorityFeePerGas) {
			const baseFee = maxFeePerGas - feeData.maxPriorityFeePerGas;
			const lowPriority = (feeData.maxPriorityFeePerGas * 75n) / 100n;
			const highPriority = (feeData.maxPriorityFeePerGas * 200n) / 100n;
			const averageMaxFee = (maxFeePerGas * gasPriceMultiplier) / 100n;
			levels = {
				low: {
					gasLimit,
					maxFeePerGas: baseFee + lowPriority,
					maxPriorityFeePerGas: lowPriority,
				},
				average: {
					gasLimit,
					maxFeePerGas: averageMaxFee,
					maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
				},
				high: {
					gasLimit,
					maxFeePerGas: baseFee + highPriority,
					maxPriorityFeePerGas: highPriority,
				},
			};
		} else if (gasPrice) {
			levels = {
				low: { gasLimit, gasPrice },
				average: { gasLimit, gasPrice: (gasPrice * gasPriceMultiplier) / 100n },
				high: { gasLimit, gasPrice: (gasPrice * 200n) / 100n },
			};
		} else {
			throw new Error("The network did not report any gas price");
		}

		estimatedFeeParams = levels;
		const fees = {
			low: formatUnits(feeParamsMaxCost(levels.low), 18),
			average: formatUnits(feeParamsMaxCost(levels.average), 18),
			high: formatUnits(feeParamsMaxCost(levels.high), 18),
		};
		estimatedFee = fees;
		// Update transaction time based on real data (asynchronously)
		transactionTimeLoading.set(true);
		updateTransactionTimes()
			.catch((error) => {
				console.error(
					"Error updating transaction times (non-blocking):",
					error,
				);
			})
			.finally(() => {
				transactionTimeLoading.set(false);
			});
		updateFeeFromLevel();
		return fees;
	} catch (e) {
		console.error("Error estimating transaction fee:", e);
		estimatedFeeParams = null;
		return null;
	} finally {
		feeLoading.set(false);
	}
}

/** Fee parameters for the level the user has selected, or null when none could be estimated. */
export function getSelectedFeeParams(): ITransactionFeeParams | null {
	if (!estimatedFeeParams) return null;
	const level = get(feeLevel);
	if (level === "custom") {
		const total = getEtherAmount(get(fee));
		if (total === null || total <= 0n) return null;
		try {
			/* A custom fee now really changes what is signed - previously it only changed a label. */
			return feeParamsFromTotal(estimatedFeeParams.average, total);
		} catch (e) {
			console.error("Invalid custom fee:", e);
			return null;
		}
	}
	return estimatedFeeParams[level];
}

export function updateFeeFromLevel() {
	const currentFeeLevel = get(feeLevel);
	console.log(
		"updateFeeFromLevel called with:",
		currentFeeLevel,
		"estimatedFee:",
		estimatedFee,
	);
	if (currentFeeLevel !== "custom") {
		fee.set(estimatedFee[currentFeeLevel]);
		console.log("Updated fee to:", get(fee));
	}
	console.log(
		"updateFeeFromLevel: Update estimated transaction time to:",
		get(transactionTime),
	);
	transactionTime.set(getEstimatedTransactionTime(currentFeeLevel));
}

export function getEstimatedTransactionTime(
	feeLevel: "low" | "average" | "high" | "custom",
): string {
	if (feeLevel === "custom") {
		// Calculate custom time based on fee amount
		const customFee = parseFloat(get(fee).toString());
		const lowFee = parseFloat(estimatedFee.low);
		const averageFee = parseFloat(estimatedFee.average);
		const highFee = parseFloat(estimatedFee.high);
		const currentEstimatedTimes = get(estimatedTransactionTimes);
		// If we don't have valid fee data or times, return unknown
		if (
			!customFee ||
			!lowFee ||
			!averageFee ||
			!highFee ||
			currentEstimatedTimes.low === "unknown" ||
			currentEstimatedTimes.average === "unknown" ||
			currentEstimatedTimes.high === "unknown"
		)
			return "unknown";
		// Determine which range the custom fee falls into
		if (customFee >= highFee) return currentEstimatedTimes.high;
		else if (customFee >= averageFee) {
			// Interpolate between average and high
			const ratio = (customFee - averageFee) / (highFee - averageFee);
			return interpolateTransactionTime(
				currentEstimatedTimes.average,
				currentEstimatedTimes.high,
				ratio,
			);
		} else if (customFee >= lowFee) {
			// Interpolate between low and average
			const ratio = (customFee - lowFee) / (averageFee - lowFee);
			return interpolateTransactionTime(
				currentEstimatedTimes.low,
				currentEstimatedTimes.average,
				ratio,
			);
		} else {
			// Custom fee is lower than low fee, estimate longer time
			return currentEstimatedTimes.low;
		}
	}
	return get(estimatedTransactionTimes)[feeLevel];
}

async function updateTransactionTimes(): Promise<void> {
	const providerInstance = get(provider);
	const network = get(selectedNetwork);
	// Keep existing values as "unknown" if no provider/network
	if (!providerInstance || !network) return;
	try {
		// Timeout for the entire operation
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("Timeout")), 25000); // 5 second timeout
		});
		const analysisPromise = (async () => {
			// Get last 5 blocks for faster analysis
			const blockCount = 5;
			const latest = await providerInstance.getBlockNumber();

			// Parallel fetching of fee history and blocks
			const [feeHistoryResult, ...blockResults] = await Promise.all([
				(async () => {
					try {
						console.debug(
							"Fetching eth_feeHistory for last",
							blockCount,
							"blocks",
						);
						const r = await providerInstance.send("eth_feeHistory", [
							`0x${blockCount.toString(16)}`,
							"latest",
							[10, 50, 90],
						]);
						console.debug("eth_feeHistory result:", r);
						return r;
					} catch (error) {
						console.debug("Error fetching eth_feeHistory:", error);
						return null;
					}
				})(),

				...Array.from({ length: blockCount }, (_, i) => {
					console.debug(`Fetching block ${latest - i}`);
					return providerInstance
						.getBlock(latest - i)
						.then((block) => {
							console.debug(`Block ${latest - i} fetched:`, block);
							return block;
						})
						.catch((error) => {
							console.debug(`Error fetching block ${latest - i}:`, error);
							return null; // Return null for failed blocks
						});
				}),
			]);
			console.debug("...");
			console.debug("Fee history result:", feeHistoryResult);
			console.debug("Block results:", blockResults);
			// Block time analysis - require at least 3 valid blocks for accuracy
			const blockTimes: number[] = [];
			const validBlocks = blockResults.filter(
				(block) => block && block.timestamp,
			);
			console.debug("Valid blocks:", validBlocks.length, validBlocks);
			// Not enough blocks for accurate calculation
			if (validBlocks.length < 3) {
				console.debug(
					"Not enough valid blocks for accurate transaction time estimation",
				);
				return null;
			}
			for (let i = 0; i < validBlocks.length - 1; i++) {
				const currentBlock = validBlocks[i];
				const previousBlock = validBlocks[i + 1];
				if (currentBlock && previousBlock) {
					const blockTime = currentBlock.timestamp - previousBlock.timestamp;
					// reasonable limits
					if (blockTime > 0 && blockTime < 300) blockTimes.push(blockTime);
				}
			}
			// Require at least 2 valid block times for accurate average
			if (blockTimes.length < 2) {
				console.debug(
					"Not enough valid block times for accurate transaction time estimation",
				);
				return null;
			}
			// Calculate precise average block time
			const avgBlockTime =
				blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length;
			avgBlockTimeStore.set(avgBlockTime);
			console.debug("Average block time calculated:", avgBlockTime, "seconds");
			// Confirmation estimate based on real data
			const confirmationBlocks = estimateConfirmationBlocks(
				feeHistoryResult,
				avgBlockTime,
			);
			confirmationBlocksStore.set(confirmationBlocks);
			// Only return if we have valid confirmation blocks
			if (!confirmationBlocks) {
				console.debug(
					"No valid confirmation blocks estimated from fee history",
				);
				return null;
			}
			return {
				low: formatTransactionTime(confirmationBlocks.low * avgBlockTime),
				average: formatTransactionTime(
					confirmationBlocks.average * avgBlockTime,
				),
				high: formatTransactionTime(confirmationBlocks.high * avgBlockTime),
			};
		})();
		// Either analysis completion or timeout
		const result = await Promise.race([analysisPromise, timeoutPromise]);
		// Only update if we got precise results
		if (result) {
			estimatedTransactionTimes.set(result);
			// Update the transaction time store after getting new data
			const currentFeeLevel = get(feeLevel);
			if (currentFeeLevel !== "custom") {
				console.debug(
					"updateTransactionTimes: Updating transaction time for fee level:",
					currentFeeLevel,
					"to:",
					result[currentFeeLevel],
				);
				transactionTime.set(result[currentFeeLevel]);
			}
		}
		// If result is null, keep existing "unknown" values
	} catch (error) {
		console.error("Error updating transaction times:", error);
		// Keep existing "unknown" values, don't override with inaccurate data
	}
}

function estimateConfirmationBlocks(
	feeHistory: any,
	avgBlockTime: number,
): {
	low: number;
	average: number;
	high: number;
} | null {
	// Return null if no fee history data - we need this for accurate estimation
	if (
		!feeHistory ||
		!feeHistory.reward ||
		!Array.isArray(feeHistory.reward) ||
		feeHistory.reward.length === 0
	)
		return null;
	try {
		// Fee percentile analysis from fee history
		const rewards = feeHistory.reward;
		const validRewards = rewards.filter(
			(reward: any) => reward && Array.isArray(reward) && reward.length >= 3,
		);
		// Need at least 3 valid rewards for accurate estimation
		if (validRewards.length < 3) return null;
		// Calculate average percentiles
		const avgPercentiles = validRewards
			.reduce(
				(
					acc: [number, number, number],
					reward: any,
				): [number, number, number] => {
					return [
						acc[0] + (parseInt(reward[0] || "0", 16) || 0),
						acc[1] + (parseInt(reward[1] || "0", 16) || 0),
						acc[2] + (parseInt(reward[2] || "0", 16) || 0),
					];
				},
				[0, 0, 0] as [number, number, number],
			)
			.map((sum: number) => sum / validRewards.length);
		// Estimate based on real data
		const [, avgPercentile] = avgPercentiles;
		// Network congestion in gwei
		const networkCongestion = avgPercentile / 1000000000 || 1;
		// Dynamic calculation based on network congestion and block time
		const baseConfirmations = Math.max(1, Math.ceil(30 / avgBlockTime)); // Target ~30 seconds for high priority
		if (networkCongestion < 5)
			return {
				low: baseConfirmations * 2,
				average: baseConfirmations,
				high: baseConfirmations,
			};
		else if (networkCongestion < 20)
			return {
				low: baseConfirmations * 3,
				average: baseConfirmations * 2,
				high: baseConfirmations,
			};
		else if (networkCongestion < 50)
			return {
				low: baseConfirmations * 4,
				average: baseConfirmations * 3,
				high: baseConfirmations,
			};
		else
			return {
				low: baseConfirmations * 6,
				average: baseConfirmations * 4,
				high: baseConfirmations * 2,
			};
	} catch (error) {
		console.error("Error in estimateConfirmationBlocks:", error);
		return null; // Return null on error instead of fallback
	}
}

function formatTransactionTime(seconds: number): string {
	if (seconds < 60) return `~${Math.round(seconds)}s`;
	else if (seconds < 3600) {
		const minutes = Math.round(seconds / 60);
		return `~${minutes} min`;
	} else {
		const hours = Math.round(seconds / 3600);
		return `~${hours} h`;
	}
}

export async function sendTransaction(
	address: string,
	etherValue: bigint,
	feeParams: ITransactionFeeParams,
	contractAddress?: string,
	selectedCurrencySymbol?: string,
	decimals?: number,
): Promise<string | null> {
	const network = get(selectedNetwork);
	const selectedWalletValue = get(selectedWallet);
	const selectedAddressValue = get(selectedAddress);
	/* Never log the wallet: it carries the mnemonic. Only its type is diagnostically useful. */
	console.log("sendTransaction: wallet type:", selectedWalletValue?.type);
	if (!selectedWalletValue || !selectedAddressValue) {
		console.error("No selected wallet or address");
		return null;
	}
	/* The caller confirmed these exact numbers - refuse rather than quietly substitute defaults. */
	assertUsableFeeParams(feeParams);

	/* One transaction per sending address at a time, so two concurrent sends cannot allocate the
	 * same nonce and silently replace each other. */
	return await withAddressLock(
		network?.chainID,
		selectedAddressValue.address,
		async (): Promise<string | null> => {
			let hash: string | null = null;
			if (selectedWalletValue.type === "software") {
				hash = (
					await sendTransactionSw(
						selectedWalletValue,
						selectedAddressValue,
						address,
						etherValue,
						feeParams,
						contractAddress,
					)
				).hash;
			} else if (selectedWalletValue.type === "trezor") {
				hash = (
					await sendTransactionTrezor(
						selectedWalletValue,
						selectedAddressValue,
						address,
						etherValue,
						feeParams,
						contractAddress,
					)
				).hash;
			} else if (selectedWalletValue.type === "ledger") {
				hash = (
					await sendTransactionLedger(
						selectedWalletValue,
						selectedAddressValue,
						address,
						etherValue,
						feeParams,
						contractAddress,
					)
				).hash;
			} else {
				console.error("Unknown wallet type:", selectedWalletValue.type);
				throw new Error("Invalid wallet configuration");
			}

			logTransaction(
				network,
				address,
				etherValue,
				contractAddress,
				hash,
				selectedCurrencySymbol,
				decimals,
			);
			return hash;
		},
	);
}

export function logTransaction(
	network: INetwork | undefined,
	address: string,
	amount: bigint,
	contractAddress?: string,
	hash?: string,
	selectedCurrencySymbol?: string,
	decimals?: number,
): void {
	if (!network) {
		console.warn("Cannot log transaction: no network provided");
		return;
	}
	const decimals2 = contractAddress
		? decimals === null || decimals === undefined
			? 18
			: decimals
		: 18;
	const symbol = contractAddress
		? selectedCurrencySymbol || ""
		: get(selectedNetwork)?.currency?.symbol || "";
	addTransactionToLog(
		network,
		address,
		amount,
		symbol,
		decimals2,
		contractAddress ?? undefined,
		hash ?? undefined,
	);
}

async function sendTransactionSw(
	selectedWalletValue: any,
	selectedAddressValue: any,
	address: string,
	etherValue: bigint,
	feeParams: ITransactionFeeParams,
	contractAddress?: string,
): Promise<TransactionResponse> {
	// Check provider connection and attempt to reconnect if needed
	let providerInstance = await ensureProviderConnected();
	if (!providerInstance) {
		throw new Error("Failed to connect to provider");
	}

	if (!selectedWalletValue.phrase) {
		throw new Error(
			"Software wallet configuration error: missing mnemonic phrase",
		);
	}

	/* Neither `mn` nor `hd_wallet` may ever be logged: the first is the seed, the second holds the
	 * derived private key. */
	const mn = Mnemonic.fromPhrase(selectedWalletValue.phrase);
	let hd_wallet = HDNodeWallet.fromMnemonic(
		mn,
		selectedAddressValue.path,
	).connect(providerInstance);
	let request: PreparedTransactionRequest;
	if (contractAddress) {
		// Token transaction - call transfer method on the token contract
		const tokenContract = new Contract(
			contractAddress,
			["function transfer(address to, uint256 amount) returns (bool)"],
			hd_wallet,
		);
		const transferData = tokenContract.interface.encodeFunctionData(
			"transfer",
			[address, etherValue],
		);
		request = {
			to: contractAddress,
			from: selectedAddressValue.address,
			value: 0n, // No ETH value for token transfers
			data: transferData,
		};
	} else {
		// Native currency transaction (ETH)
		request = {
			to: address,
			from: selectedAddressValue.address,
			value: etherValue,
		};
	}

	/* Sign exactly the fee the user confirmed. Leaving these unset let ethers fill in whatever the
	 * node happened to report at signing time, which could be more than was shown and approved. */
	request.gasLimit = feeParams.gasLimit;
	if (feeParams.maxFeePerGas !== undefined) {
		request.maxFeePerGas = feeParams.maxFeePerGas;
		if (feeParams.maxPriorityFeePerGas !== undefined) {
			request.maxPriorityFeePerGas = feeParams.maxPriorityFeePerGas;
		}
	} else if (feeParams.gasPrice !== undefined) {
		request.gasPrice = feeParams.gasPrice;
	}

	/* The gas limit was estimated when the transaction was composed; re-check it against current
	 * chain state. Raising it silently would exceed the approved maximum cost, so this only ever
	 * refuses - the user has to confirm the higher fee explicitly. */
	try {
		const currentEstimate = await providerInstance.estimateGas({
			from: selectedAddressValue.address,
			to: (contractAddress ?? address) as string,
			...(request.data !== undefined ? { data: request.data } : {}),
			value: contractAddress ? 0n : etherValue,
		});
		if (currentEstimate > feeParams.gasLimit) {
			throw new Error(
				`This transaction now needs ${currentEstimate} gas, more than the ${feeParams.gasLimit} you confirmed. Review the fee and try again.`,
			);
		}
	} catch (e) {
		if (e instanceof Error && e.message.includes("you confirmed")) throw e;
		/* A node that cannot estimate (reverting transfer, rate limit) is a reason to stop, not to
		 * broadcast a transaction that will probably fail and still cost gas. */
		throw new Error(
			`Could not verify the gas limit for this transaction: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// Get and set proper nonce to avoid conflicts
	// Use 'latest' instead of 'pending' to get confirmed nonce, then check for pending transactions
	const confirmedNonce = await providerInstance.getTransactionCount(
		selectedAddressValue.address,
		"latest",
	);
	const pendingNonce = await providerInstance.getTransactionCount(
		selectedAddressValue.address,
		"pending",
	);

	// If there are pending transactions, we need to wait or use a higher nonce
	if (pendingNonce > confirmedNonce) {
		const pendingCount = pendingNonce - confirmedNonce;
		console.warn(
			`${pendingCount} pending transaction(s) for this address (confirmed ${confirmedNonce}, pending ${pendingNonce})`,
		);

		// Check if we should warn user about potential stuck transactions
		if (pendingCount > 3) {
			// Ask user if they want to use emergency mode (REPLACE stuck transaction)
			const useEmergencyMode = confirm(
				`STUCK TRANSACTIONS DETECTED\n\n` +
					`You have ${pendingCount} pending transactions (nonce ${confirmedNonce}-${pendingNonce - 1}) blocking new transactions.\n\n` +
					`EMERGENCY MODE: Replace the FIRST stuck transaction (nonce ${confirmedNonce}) with this transaction using 3x gas price?\n\n` +
					`This will REPLACE the stuck transaction and unblock the queue.\n` +
					`This will cost up to three times the fee you just confirmed.\n\n` +
					`Click OK for Emergency Replacement (3x gas price)\n` +
					`Click Cancel to abort transaction`,
			);

			if (!useEmergencyMode) {
				throw new Error(
					`Transaction cancelled. You have ${pendingCount} stuck transactions blocking new ones.\n\nSolutions:\n1. Wait for pending transactions to complete\n2. Use Emergency Replacement Mode (3x gas price)\n3. Use a different wallet address`,
				);
			}

			// Emergency mode: Use the FIRST stuck nonce with higher gas price
			request.nonce = confirmedNonce; // Use the FIRST stuck nonce to unblock queue

			/* This now actually multiplies something. Before the fee parameters were set explicitly
			 * above, `request` carried no gas price at all at this point, so both branches were dead
			 * code and the promised 3x replacement never happened. */
			if (request.maxFeePerGas) {
				request.maxFeePerGas = request.maxFeePerGas * 3n;
				request.maxPriorityFeePerGas = request.maxPriorityFeePerGas
					? request.maxPriorityFeePerGas * 3n
					: request.maxFeePerGas / 2n;
			} else if (request.gasPrice) {
				request.gasPrice = request.gasPrice * 3n;
			}

			console.log(
				"Replacing stuck nonce",
				confirmedNonce,
				"with 3x gas price",
			);
		} else {
			// Use the pending nonce to queue after existing pending transactions
			request.nonce = pendingNonce;
		}
	} else {
		// No pending transactions, use the confirmed nonce
		request.nonce = confirmedNonce;
	}

	console.log("Sending transaction with nonce:", request.nonce);
	try {
		let tx = await hd_wallet.sendTransaction(request);
		console.log("Transaction sent, hash:", tx.hash);
		return tx;
	} catch (e) {
		/* No client-side lock can cover the same address being used from another device, so a nonce
		 * collision reported by the node has to surface as a clear error instead of looking like a
		 * generic RPC failure - and it must never be retried blindly with the same nonce. */
		throw describeSendError(e);
	}
}

/** Turns provider errors that matter to the user into something actionable. */
function describeSendError(e: unknown): Error {
	const message = e instanceof Error ? e.message : String(e);
	const lower = message.toLowerCase();
	if (lower.includes("nonce too low") || lower.includes("already known") || lower.includes("replacement transaction underpriced")) {
		return new Error(
			"This transaction was rejected because another transaction from the same address was sent first (nonce conflict). " +
				"If you are using this wallet on another device or window, wait for that transaction to confirm and try again. " +
				`Original error: ${message}`,
		);
	}
	if (lower.includes("insufficient funds")) {
		return new Error(`The balance does not cover the amount plus the confirmed fee. Original error: ${message}`);
	}
	return e instanceof Error ? e : new Error(message);
}

function interpolateTransactionTime(
	timeA: string,
	timeB: string,
	ratio: number,
): string {
	// Parse time strings (e.g., "~30s", "~2 min", "~1 h")
	const parseTime = (timeStr: string): number => {
		const match = timeStr.match(/~(\d+)\s*(s|min|h)/);
		if (!match) return 0;
		const value = parseInt(match[1] ?? "0");
		const unit = match[2] ?? "s";
		switch (unit) {
			case "s":
				return value;
			case "min":
				return value * 60;
			case "h":
				return value * 3600;
			default:
				return value;
		}
	};
	const secondsA = parseTime(timeA);
	const secondsB = parseTime(timeB);
	if (secondsA === 0 || secondsB === 0) return timeA; // fallback
	// Interpolate between the two times
	const interpolatedSeconds = secondsA + (secondsB - secondsA) * ratio;
	return formatTransactionTime(interpolatedSeconds);
}
