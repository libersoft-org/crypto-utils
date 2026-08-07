import { get } from "svelte/store";
import { provider } from "./provider";

/* The exact gas parameters a transaction is signed with.
 *
 * Passing a single opaque "fee" total around was the root of a real problem: the UI computed one
 * number, showed it to the user, checked the balance against it - and then every signing path threw
 * it away and re-read provider.getFeeData(). The user could therefore be charged more than they
 * confirmed, a custom fee did nothing at all, and the balance check compared against a number that
 * was never used. These are the values that actually reach the signer. */
export interface ITransactionFeeParams {
	gasLimit: bigint;
	/** EIP-1559 */
	maxFeePerGas?: bigint;
	maxPriorityFeePerGas?: bigint;
	/** Legacy networks without EIP-1559 */
	gasPrice?: bigint;
}

/** Worst case the sender can pay for these parameters - what the user must be shown. */
export function feeParamsMaxCost(params: ITransactionFeeParams): bigint {
	const perGas = params.maxFeePerGas ?? params.gasPrice ?? 0n;
	return params.gasLimit * perGas;
}

export function isEip1559(params: ITransactionFeeParams): boolean {
	return params.maxFeePerGas !== undefined;
}

/** Rejects parameters that cannot produce a valid transaction. */
export function assertUsableFeeParams(params: ITransactionFeeParams): void {
	if (params.gasLimit <= 0n) throw new Error("Invalid fee parameters: gas limit must be positive");
	if (params.maxFeePerGas === undefined && params.gasPrice === undefined) {
		throw new Error("Invalid fee parameters: neither maxFeePerGas nor gasPrice is set");
	}
	if (params.maxFeePerGas !== undefined && params.maxFeePerGas <= 0n) {
		throw new Error("Invalid fee parameters: maxFeePerGas must be positive");
	}
	if (params.gasPrice !== undefined && params.gasPrice <= 0n) {
		throw new Error("Invalid fee parameters: gasPrice must be positive");
	}
	if (params.maxPriorityFeePerGas !== undefined && params.maxFeePerGas !== undefined && params.maxPriorityFeePerGas > params.maxFeePerGas) {
		throw new Error("Invalid fee parameters: maxPriorityFeePerGas exceeds maxFeePerGas");
	}
}

/** Rebuilds fee parameters so that the maximum cost matches a total the user typed in. */
export function feeParamsFromTotal(base: ITransactionFeeParams, totalWei: bigint): ITransactionFeeParams {
	if (base.gasLimit <= 0n) throw new Error("Cannot derive fee parameters without a gas limit");
	const perGas = totalWei / base.gasLimit;
	if (perGas <= 0n) throw new Error("The chosen fee is too low for this transaction");
	if (base.maxFeePerGas !== undefined) {
		const priority = base.maxPriorityFeePerGas !== undefined && base.maxPriorityFeePerGas < perGas ? base.maxPriorityFeePerGas : perGas;
		return {
			gasLimit: base.gasLimit,
			maxFeePerGas: perGas,
			maxPriorityFeePerGas: priority,
		};
	}
	return { gasLimit: base.gasLimit, gasPrice: perGas };
}

/* One in-flight transaction per address per chain.
 *
 * The nonce used to be read straight from the provider and written into the request with nothing
 * serialising the two steps, so two sends started at the same time - from two windows, two tabs or
 * a double click - could read the same pending nonce. One of them then silently replaced the other
 * while the UI reported both as sent. */
const addressLocks = new Map<string, Promise<unknown>>();

function lockKey(chainId: bigint | number | undefined, address: string): string {
	return `${chainId ?? "unknown"}:${address.toLowerCase()}`;
}

/** Runs `fn` with exclusive access to one sending address. */
export function withAddressLock<T>(chainId: bigint | number | undefined, address: string, fn: () => Promise<T>): Promise<T> {
	const key = lockKey(chainId, address);
	const previous = addressLocks.get(key) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	/* Keep the chain alive regardless of outcome, but never leak the rejection. */
	addressLocks.set(
		key,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

/** True while a transaction from this address is being prepared or broadcast. */
export function isAddressBusy(chainId: bigint | number | undefined, address: string): boolean {
	return addressLocks.has(lockKey(chainId, address));
}

/** Next nonce to use, read inside the address lock so two sends cannot pick the same one. */
export async function nextNonce(address: string): Promise<number> {
	const providerInstance = get(provider);
	if (!providerInstance) throw new Error("No provider available");
	return await providerInstance.getTransactionCount(address, "pending");
}
