import { Contract } from "ethers";

export interface MulticallCall {
	target: string;
	callData: string;
}

export const refreshInterval = 30;

// Multicall3 contract - uses the same address on most networks
export const multicall3Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const multicallABI = [
	"function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)",
];

// Generic Multicall executor
export async function executeMulticall<T>(
	addresses: string[],
	abi: string[],
	functionNames: string[],
	provider: any,
	_network: any,
	additionalParams: any[] = [],
	processor: (
		returnData: string[],
		addresses: string[],
		erc20Interface: any,
		additionalParams: any[],
	) => Map<string, T>,
): Promise<Map<string, T> | null> {
	try {
		//console.log(`Trying Multicall3 at ${multicall3Address} for chainID ${network.chainID}`);

		const firstAddress = addresses[0];
		if (!firstAddress) return null;
		const multicallContract = new Contract(
			multicall3Address,
			multicallABI,
			provider,
		);
		const erc20Interface = new Contract(firstAddress, abi, provider).interface;

		// Prepare calls for Multicall
		const calls: MulticallCall[] = [];
		addresses.forEach((address) => {
			functionNames.forEach((funcName) => {
				calls.push({
					target: address,
					callData: erc20Interface.encodeFunctionData(
						funcName,
						additionalParams,
					),
				});
			});
		});

		//console.log(`aaUsing Multicall for ${addresses.length} tokens (${calls.length} calls) in ONE blockchain transaction`);

		// Execute Multicall
		const [, returnData] = await multicallContract["aggregate"]!(calls);

		// Process results using the provided processor function
		return processor(returnData, addresses, erc20Interface, additionalParams);
	} catch (error) {
		//console.debug(`Multicall3 failed for chainID ${network.chainID}:`, error);
		return null;
	}
}

// Helper functions
export function updateReactiveMap<T>(
	map: Map<string, T>,
	updater: (map: Map<string, T>) => void,
): Map<string, T> {
	updater(map);
	return new Map(map);
}

export function updateReactiveSet<T>(
	set: Set<T>,
	updater: (set: Set<T>) => void,
): Set<T> {
	updater(set);
	return new Set(set);
}
