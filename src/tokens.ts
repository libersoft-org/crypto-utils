import { Contract } from 'ethers';
import { get, writable, derived } from 'svelte/store';
import type { IAmount, IBalance, IBalanceWithFiat, Guid, ContractAddress } from './types.ts';
import {
	provider,
	getProviderUrl

} from './provider.ts';
import { selectedNetwork } from './network.ts';
import { selectedAddress } from './wallet.ts';
import { isValidContractAddress } from './address-validation.ts';
import { updateAllFiats } from './fiat.ts';
import {
	executeMulticall,
	multicall3Address,
	multicallABI,
	type MulticallCall
} from './common';



/**
 * Basic token definition - the minimal data needed to identify a token
 */
export interface ITokenDef {
	contract_address: ContractAddress;
	iconURL?: string;
}

/**
 * User-configured token - includes GUID for identification in user's token list
 */
export interface ITokenConf extends ITokenDef {
	guid: Guid;
}

/**
 * Token information loaded from blockchain (name, symbol, decimals)
 */
export interface ITokenLoadedInfo {
	symbol: string;
	name: string;
}

export interface BatchRequestPayload {
	jsonrpc: string;
	id: number;
	method: string;
	params: any[];
}




/**
 * Token stores for managing token-related data
 */

/**
 * Store for token information (name, symbol) keyed by contract address
 */
export const tokenInfos = writable<Map<ContractAddress, ITokenLoadedInfo>>(new Map());

/**
 * Store for token balances (with fiat conversion) keyed by contract address
 */
export const tokenBalances = writable<Map<ContractAddress, IBalanceWithFiat>>(new Map());

/**
 * Set of contract addresses currently loading balance data
 */
export const loadingTokens = writable<Set<ContractAddress>>(new Set());

/**
 * Set of contract addresses currently loading info data (name, symbol)
 */
export const loadingTokenInfos = writable<Set<ContractAddress>>(new Set());

/**
 * Store for configured tokens from the selected network
 * Simple accessor to selectedNetwork.tokens without transformation
 */
export const tokenConfs = derived([selectedNetwork], ([$selectedNetwork]) => {
	return $selectedNetwork?.tokens || [];
});


/**
 * Display-ready token data interface for UI components
 * Combines token configuration with loaded data and loading states
 */
export interface ITokenForDisplay {
	conf: ITokenConf;
	info: ITokenLoadedInfo | undefined;
	balance: IBalanceWithFiat | undefined;
	isLoadingInfo: boolean;
	isLoadingBalance: boolean;
}

/**
 * Derived store that combines all token data for display purposes
 * Provides a reactive array of display-ready token data for UI components
 */
export const tokensForDisplay = derived(
	[tokenConfs, tokenInfos, tokenBalances, loadingTokens, loadingTokenInfos],
	([$tokenConfs, $tokenInfos, $tokenBalances, $loadingTokens, $loadingTokenInfos]) => {
		// Filter tokens that have contract addresses
		const tokensWithContracts = $tokenConfs.filter(token => 
			token.contract_address && isValidContractAddress(token.contract_address)
		);
		
		// Transform into display-ready data
		return tokensWithContracts.map(t => {
			const contractAddress = t.contract_address;
			if (!contractAddress) return null;

			const tokenInfo = $tokenInfos.get(contractAddress);
			const tokenBalance = $tokenBalances.get(contractAddress);
			const isLoadingInfo = $loadingTokenInfos.has(contractAddress);
			const isLoadingBalance = $loadingTokens.has(contractAddress);

			return {
				conf: t,
				info: tokenInfo,
				balance: tokenBalance,
				isLoadingInfo,
				isLoadingBalance,
			} satisfies ITokenForDisplay;
		}).filter(Boolean) as ITokenForDisplay[];
	}
);


// Helper functions for store updates
function updateReactiveMap<T>(map: Map<string, T>, updater: (map: Map<string, T>) => void): Map<string, T> {
	updater(map);
	return new Map(map);
}

export function updateTokenInfo(contractAddress: string, tokenInfo: { name: string; symbol: string } | null): void {
	tokenInfos.update(map => {
		const newMap = new Map(map);
		if (tokenInfo) {
			newMap.set(contractAddress, tokenInfo);
		} else {
			newMap.delete(contractAddress);
		}
		return newMap;
	});
}

function updateReactiveSet<T>(set: Set<T>, updater: (set: Set<T>) => void): Set<T> {
	updater(set);
	return new Set(set);
}

/**
 * Get all configured tokens that have contract addresses
 * @returns Array of tokens with valid contract addresses
 */
export function getTokensWithContracts(): ITokenConf[] {
	return get(tokenConfs).filter(token => 
		token.contract_address && isValidContractAddress(token.contract_address)
	);
}

// Token balance management functions
/**
 * Refresh the balance for a specific token contract
 * @param contractAddress - The contract address of the token to refresh
 */
export async function refreshTokenBalance(contractAddress: ContractAddress): Promise<void> {
	const addr = get(selectedAddress);
	if (!addr) return;

	loadingTokens.update(set => updateReactiveSet(set, s => s.add(contractAddress)));

	try {
		const amounts = await getBatchTokenAmountsByAddresses([contractAddress]);
		const amount = amounts.get(contractAddress);
		
		if (amount) {
			const tokenInfo = get(tokenInfos).get(contractAddress);
			const tokenBalance: IBalance = {
				amount: amount.amount,
				currency: tokenInfo?.symbol || 'TOKEN',
				decimals: amount.decimals
			};
			
			// Store crypto balance only
			tokenBalances.update(map => updateReactiveMap(map, m => {
				m.set(contractAddress, {
					crypto: tokenBalance,
					fiat: null, // Will be updated by updateAllFiats()
					timestamp: new Date()
				});
			}));
			
			// Update fiat conversion after successful balance refresh
			await updateAllFiats();
		}
	} catch (error) {
		console.error(`Error refreshing token balance for ${contractAddress}:`, error);
	} finally {
		loadingTokens.update(set => updateReactiveSet(set, s => s.delete(contractAddress)));
	}
}

export async function loadAllTokenInfos(): Promise<void> {
	const tokensWithContracts = getTokensWithContracts();
	const currentlyLoading = get(loadingTokenInfos);
	const currentInfos = get(tokenInfos);
	
	const tokensToLoad = tokensWithContracts.filter(token => 
		token.contract_address && 
		!currentlyLoading.has(token.contract_address) && 
		!currentInfos.has(token.contract_address)
	);

	if (!tokensToLoad.length) return;

	console.log('Loading token infos for', tokensToLoad.length, 'tokens');

	// Mark all as loading
	loadingTokenInfos.update(set => updateReactiveSet(set, s => {
		tokensToLoad.forEach(token => token.contract_address && s.add(token.contract_address));
	}));

	try {
		const contractAddresses = tokensToLoad.map(token => token.contract_address);
		const batchInfos = await getBatchTokensInfo(contractAddresses);
		
		// Update token infos
		tokenInfos.update(map => updateReactiveMap(map, m => {
			batchInfos.forEach((info, contractAddress) => {
				m.set(contractAddress, info);
			});
		}));

	} catch (error) {
		console.error('Error in batch token info loading:', error);
		// Fallback for all tokens
		tokenInfos.update(map => updateReactiveMap(map, m => {
			tokensToLoad.forEach(token => {
				if (token.contract_address && !m.has(token.contract_address)) {
					m.set(token.contract_address, { symbol: 'UNKNOWN', name: 'Unknown token' });
				}
			});
		}));
	} finally {
		// Mark all as completed
		loadingTokenInfos.update(set => updateReactiveSet(set, s => {
			tokensToLoad.forEach(token => token.contract_address && s.delete(token.contract_address));
		}));
	}
}




// Common ERC-20 ABIs
const erc20InfoABI = ['function name() view returns (string)', 'function symbol() view returns (string)'];
const erc20BalanceABI = ['function balanceOf(address owner) view returns (uint256)', 'function decimals() view returns (uint8)'];


async function fallbackBatchBalanceCallByAddress(tokensWithAddresses: any[], provider: any, network: any, addr: any): Promise<Map<string, IBalance>> {
	const result = new Map<string, IBalance>();

	try {
		// Create batch request payload for JSON-RPC
		const batchPayload: BatchRequestPayload[] = [];
		let id = 1;

		tokensWithAddresses.forEach(token => {
			const contract = new Contract(token.contract_address, erc20BalanceABI, provider);
			// Add balanceOf() call to batch
			batchPayload.push({
				jsonrpc: '2.0',
				id: id++,
				method: 'eth_call',
				params: [
					{
						to: token.contract_address,
						data: contract.interface.encodeFunctionData('balanceOf', [addr.address])
					},
					'latest'
				]
			});
			// Add decimals() call to batch
			batchPayload.push({
				jsonrpc: '2.0',
				id: id++,
				method: 'eth_call',
				params: [
					{
						to: token.contract_address,
						data: contract.interface.encodeFunctionData('decimals')
					},
					'latest'
				]
			});
		});
		console.log(`Fallback: Sending JSON-RPC batch with ${batchPayload.length} calls for ${tokensWithAddresses.length} token balances`);
		// Get provider URL
		const providerUrl = getProviderUrl(network);
		// Send single batch JSON-RPC request
		const response = await fetch(providerUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(batchPayload)
		});
		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
		const batchResults = await response.json();
		if (!Array.isArray(batchResults)) throw new Error('Invalid batch response format');
		// Process results
		const contract = new Contract(tokensWithAddresses[0].contract_address, erc20BalanceABI, provider);
		for (let i = 0; i < tokensWithAddresses.length; i++) {
			const balanceIndex = i * 2;
			const decimalsIndex = i * 2 + 1;
			const token = tokensWithAddresses[i];
			try {
				const balanceResult = batchResults[balanceIndex];
				const decimalsResult = batchResults[decimalsIndex];
				if (balanceResult?.result && decimalsResult?.result) {
					const balance = contract.interface.decodeFunctionResult('balanceOf', balanceResult.result)[0];
					const decimals = contract.interface.decodeFunctionResult('decimals', decimalsResult.result)[0];
					result.set(token.contract_address, {
						amount: balance,
						currency: 'TOKEN',
						decimals: Number(decimals)
					});
				} else {
					console.debug(`Failed to get balance for token ${token.contract_address} via JSON-RPC batch`);
				}
			} catch (error) {
				console.debug(`Error processing token ${token.contract_address} from JSON-RPC batch:`, error instanceof Error ? error.message : String(error));
			}
		}
		console.log(`JSON-RPC batch processed ${result.size}/${tokensWithAddresses.length} token balances successfully`);
	} catch (error) {
		console.debug('Error in batch balance call by address:', error);
	}
	return result;
}


// Helper functions for address-based batch loading
async function tryMulticallBalancesByAddress(tokensWithAddresses: any[], provider: any, network: any, addr: any): Promise<Map<string, IAmount> | null> {
	return executeMulticallBalancesByAddress(tokensWithAddresses, provider, network, addr);
}

async function executeMulticallBalancesByAddress(tokensWithAddresses: any[], provider: any, network: any, addr: any): Promise<Map<string, IAmount> | null> {
	try {
		console.log(`Trying Multicall3 for ${tokensWithAddresses.length} token balances by address`);
		const multicallContract = new Contract(multicall3Address, multicallABI, provider);
		const erc20Interface = new Contract(tokensWithAddresses[0].contract_address, erc20BalanceABI, provider).interface;
		// Prepare calls for Multicall
		const calls: MulticallCall[] = [];
		tokensWithAddresses.forEach(token => {
			// Add balanceOf() call
			calls.push({
				target: token.contract_address,
				callData: erc20Interface.encodeFunctionData('balanceOf', [addr.address])
			});
			// Add decimals() call
			calls.push({
				target: token.contract_address,
				callData: erc20Interface.encodeFunctionData('decimals')
			});
		});
		console.log(`ccUsing Multicall for ${tokensWithAddresses.length} token balances (${calls.length} calls) in ONE blockchain transaction`);
		// Execute Multicall
		const [blockNumber, returnData] = await multicallContract.aggregate(calls);
		// Process results
		const result = new Map<string, IAmount>();
		for (let i = 0; i < tokensWithAddresses.length; i++) {
			const balanceIndex = i * 2;
			const decimalsIndex = i * 2 + 1;
			const token = tokensWithAddresses[i];
			try {
				if (returnData[balanceIndex] && returnData[decimalsIndex]) {
					const balance = erc20Interface.decodeFunctionResult('balanceOf', returnData[balanceIndex])[0];
					const decimals = erc20Interface.decodeFunctionResult('decimals', returnData[decimalsIndex])[0];
					result.set(token.contract_address, {
						amount: balance,
						decimals: Number(decimals)
					});
				} else {
					console.debug(`Failed to get balance for token ${token.contract_address} via Multicall`);
				}
			} catch (error) {
				console.debug(`Error processing token ${token.contract_address} from Multicall:`, error instanceof Error ? error.message : String(error));
			}
		}
		console.debug(`Multicall processed ${result.size}/${tokensWithAddresses.length} token balances successfully`);
		return result;
	} catch (error) {
		console.debug(`Multicall3 failed for token balances:`, error);
		return null;
	}
}


// NEW: Batch token balances by contract addresses (not symbols) (this function is not aware of token symbols)
export async function getBatchTokenAmountsByAddresses(contractAddresses: string[]): Promise<Map<string, IAmount>> {
	const p = get(provider);
	const net = get(selectedNetwork);
	const addr = get(selectedAddress);
	const result = new Map<string, IAmount>();

	if (!net || !p || !addr || contractAddresses.length === 0) {
		console.error('Network, provider, address not set or no addresses provided');
		return result;
	}

	// Create token objects with addresses for compatibility with existing functions
	const tokensWithAddresses = contractAddresses.map(address => ({ contract_address: address }));

	console.log(`Starting batch balance loading for ${tokensWithAddresses.length} tokens by addresses`);

	let remainingTokens = [...tokensWithAddresses];

	try {
		// Try Multicall3 first
		if (remainingTokens.length > 0) {
			const multicallResult = await tryMulticallBalancesByAddress(remainingTokens, p, net, addr);
			if (multicallResult && multicallResult.size > 0) {
				// Add successful results to the final result
				multicallResult.forEach((balance, contractAddress) => {
					result.set(contractAddress, balance);
				});

				// Filter out successful tokens from remaining
				remainingTokens = remainingTokens.filter(token => !multicallResult.has(token.contract_address));
				console.log(`Multicall succeeded for ${multicallResult.size} tokens, ${remainingTokens.length} tokens remaining`);
			} else {
				console.log('Multicall returned no results, all tokens will try fallback');
			}
		}

		// Fallback: JSON-RPC batch for remaining/failed tokens
		if (remainingTokens.length > 0) {
			try {
				const batchResult = await fallbackBatchBalanceCallByAddress(remainingTokens, p, net, addr);
				if (batchResult.size > 0) {
					batchResult.forEach((balance, contractAddress) => {
						result.set(contractAddress, balance);
					});

					remainingTokens = remainingTokens.filter(token => !batchResult.has(token.contract_address));
					console.log(`JSON-RPC batch succeeded for ${batchResult.size} tokens, ${remainingTokens.length} tokens still remaining`);
				}
			} catch (error) {
				console.debug('JSON-RPC batch for balances failed, falling back to individual calls:', error);
			}
		}

		// Fallback: individual calls in parallel for remaining tokens
		if (remainingTokens.length > 0) {
			console.log(`Fallback: Loading ${remainingTokens.length} token balances individually`);
			const balancePromises = remainingTokens.map(async token => {
				try {
					const tokenBalance = await getTokenBalanceByAddress(token.contract_address);
					return { contractAddress: token.contract_address, balance: tokenBalance };
				} catch (error) {
					console.debug(`Error getting balance for ${token.contract_address}:`, error);
					return null;
				}
			});

			const balanceResults = await Promise.all(balancePromises);
			balanceResults.forEach(resultItem => {
				if (resultItem?.balance) {
					result.set(resultItem.contractAddress, resultItem.balance);
				}
			});
		}
	} catch (error) {
		console.debug('Error in batch token balance loading by addresses:', error);
	}

	console.log(`Final result: ${result.size}/${contractAddresses.length} token balances loaded successfully`);
	return result;
}


export async function getTokenBalanceByAddress(contractAddress: string): Promise<IBalance | null> {
	const p = get(provider);
	const addr = get(selectedAddress);
	if (!p || !addr) {
		console.error('Provider or address not set');
		return null;
	}
	try {
		const abi = ['function balanceOf(address owner) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
		const contract = new Contract(contractAddress, abi, p);
		const [balance, decimals, symbol] = await Promise.all([contract.balanceOf(addr.address), contract.decimals(), contract.symbol()]);
		return {
			amount: balance,
			currency: symbol,
			decimals: Number(decimals)
		};
	} catch (error) {
		console.debug('Error while getting token balance by address:', error instanceof Error ? error.message : String(error));
		return null;
	}
}

// Direct token balance call (to avoid recursion in fallback)
async function getDirectTokenBalance(token: any, provider: any, addr: any): Promise<IBalance | null> {
	try {
		if (!token.contract_address) {
			console.error('Token contract address is missing for', token.symbol);
			return null;
		}
		const abi = ['function balanceOf(address owner) view returns (uint256)', 'function decimals() view returns (uint8)'];
		const contract = new Contract(token.contract_address, abi, provider);
		const [balance, decimals] = await Promise.all([contract.balanceOf(addr.address), contract.decimals()]);
		return {
			amount: balance,
			currency: token.symbol,
			decimals: Number(decimals)
		};
	} catch (error) {
		console.debug('Error while getting direct token balance:', error);
		return null;
	}
}


export async function getBatchTokenBalances(): Promise<Map<string, IBalance>> {
	const p = get(provider);
	const net = get(selectedNetwork);
	const addr = get(selectedAddress);
	const tokenList = get(tokenConfs);
	const result = new Map<string, IBalance>();

	if (!net || !p || !addr) {
		console.error('Network, provider, or address not set');
		return result;
	}

	// Filter tokens that have valid contract addresses
	const tokensWithAddresses = tokenList.filter(token => 
		token.contract_address && isValidContractAddress(token.contract_address)
	);

	if (tokensWithAddresses.length === 0) return result;

	console.log(
		`Starting batch balance loading for ${tokensWithAddresses.length} tokens:`,
		tokensWithAddresses.map(t => t.contract_address)
	);

	let remainingTokens = [...tokensWithAddresses]; // Create a copy

	try {
		// Try Multicall3 first
		if (remainingTokens.length > 0) {
			const multicallResult = await tryMulticallBalances(remainingTokens, p, net, addr);
			if (multicallResult && multicallResult.size > 0) {
				// Add successful results to the final result
				multicallResult.forEach((balance, symbol) => {
					result.set(symbol, balance);
				});

				// Filter out successful tokens from remaining
				remainingTokens = remainingTokens.filter(token => !multicallResult.has(token.contract_address));
				console.log(`Multicall succeeded for ${multicallResult.size} tokens, ${remainingTokens.length} tokens remaining`);
			} else {
				console.log(`Multicall returned no results, all ${remainingTokens.length} tokens will try fallback`);
			}
		}

		// Fallback 2: JSON-RPC batch for remaining/failed tokens
		if (remainingTokens.length > 0) {
			try {
				const batchResult = await fallbackBatchBalanceCall(remainingTokens, p, net, addr);
				if (batchResult.size > 0) {
					batchResult.forEach((balance, symbol) => {
						result.set(symbol, balance);
					});

					// Filter out successful tokens from remaining
					remainingTokens = remainingTokens.filter(token => !batchResult.has(token.contract_address));
					console.log(`JSON-RPC batch succeeded for ${batchResult.size} tokens, ${remainingTokens.length} tokens still remaining`);
				}
			} catch (error) {
				console.warn('JSON-RPC batch for balances failed, falling back to individual calls:', error);
			}
		}

		// Fallback 3: individual calls in parallel for remaining tokens
		if (remainingTokens.length > 0) {
			console.log(`Fallback: Loading ${remainingTokens.length} token balances individually`);
			const balancePromises = remainingTokens.map(async token => {
				try {
					// Use direct contract call to avoid infinite recursion
					const tokenBalance = await getDirectTokenBalance(token, p, addr);
					return { symbol: token.contract_address, balance: tokenBalance };
				} catch (error) {
					console.warn(`Error getting balance for ${token.contract_address}:`, error);
					return { symbol: token.contract_address, balance: null };
				}
			});
			const balanceResults = await Promise.all(balancePromises);
			balanceResults.forEach(({ symbol, balance }) => {
				if (balance) {
					result.set(symbol, balance);
					console.log(`Individual call succeeded for ${symbol}`);
				} else {
					console.warn(`Individual call failed for ${symbol}`);
				}
			});
		}
	} catch (error) {
		console.info('Error in batch token balance loading:', error);
	}

	console.log(`Final result: successfully loaded ${result.size}/${tokensWithAddresses.length} token balances`);
	console.log('Successful tokens:', Array.from(result.keys()));
	const failedTokens = tokensWithAddresses.filter(token => !result.has(token.contract_address));
	if (failedTokens.length > 0) {
		console.info(
			'Failed tokens:',
			failedTokens.map(t => t.contract_address)
		);
	}

	return result;
}


// Wrapper for token balance Multicall
async function tryMulticallBalances(tokensWithAddresses: any[], provider: any, network: any, addr: any): Promise<Map<string, IBalance> | null> {
	return executeMulticallBalances(tokensWithAddresses, provider, network, addr);
}


// Special Multicall executor for balances (handles different function parameters)
async function executeMulticallBalances(tokensWithAddresses: any[], provider: any, network: any, addr: any): Promise<Map<string, IBalance> | null> {
	try {
		console.debug(`Trying Multicall3 at ${multicall3Address} for chainID ${network.chainID}`);

		const multicallContract = new Contract(multicall3Address, multicallABI, provider);
		const erc20Interface = new Contract(tokensWithAddresses[0].contract_address, erc20BalanceABI, provider).interface;

		// Prepare calls for Multicall
		const calls: MulticallCall[] = [];
		tokensWithAddresses.forEach(token => {
			calls.push({
				target: token.contract_address,
				callData: erc20Interface.encodeFunctionData('balanceOf', [addr.address])
			});
			calls.push({
				target: token.contract_address,
				callData: erc20Interface.encodeFunctionData('decimals')
			});
		});

		console.debug(`bbUsing Multicall for ${tokensWithAddresses.length} token balances (${calls.length} calls) in ONE blockchain transaction`);

		// Execute Multicall
		const [blockNumber, returnData] = await multicallContract.aggregate(calls);

		// Process results
		return processTokenBalanceResults(returnData, tokensWithAddresses, erc20Interface, []);
	} catch (error) {
		console.debug(`Multicall3 failed for chainID ${network.chainID}:`, error);
		return null;
	}
}


// Process token info results from JSON-RPC batch
function processTokenInfoBatchResults(batchResults: any[], addresses: string[], contract: Contract): Map<string, {
	name: string;
	symbol: string
}> {
	const result = new Map<string, { name: string; symbol: string }>();

	for (let i = 0; i < addresses.length; i++) {
		const nameIndex = i * 2;
		const symbolIndex = i * 2 + 1;
		const address = addresses[i];

		try {
			const nameResult = batchResults[nameIndex];
			const symbolResult = batchResults[symbolIndex];

			if (nameResult?.result && symbolResult?.result) {
				const name = contract.interface.decodeFunctionResult('name', nameResult.result)[0];
				const symbol = contract.interface.decodeFunctionResult('symbol', symbolResult.result)[0];
				result.set(address, {
					name: String(name),
					symbol: String(symbol)
				});
			} else {
				console.info(`Failed to get info for token ${address}`);
			}
		} catch (error) {
			console.info(`Error processing token ${address}:`, error instanceof Error ? error.message : String(error));
		}
	}

	return result;
}

async function fallbackBatchCall(contractAddresses: string[], provider: any, network: any): Promise<Map<string, {
	name: string;
	symbol: string
}>> {
	return executeBatchCall(contractAddresses, erc20InfoABI, ['name', 'symbol'], provider, network, [], processTokenInfoBatchResults);
}

// Process token balance results from JSON-RPC batch
function processTokenBalanceBatchResults(batchResults: any[], tokens: any[], contract: Contract): Map<string, IBalance> {
	const result = new Map<string, IBalance>();

	for (let i = 0; i < tokens.length; i++) {
		const balanceIndex = i * 2;
		const decimalsIndex = i * 2 + 1;
		const token = tokens[i];

		try {
			const balanceResult = batchResults[balanceIndex];
			const decimalsResult = batchResults[decimalsIndex];

			if (balanceResult?.result && decimalsResult?.result) {
				const balance = contract.interface.decodeFunctionResult('balanceOf', balanceResult.result)[0];
				const decimals = contract.interface.decodeFunctionResult('decimals', decimalsResult.result)[0];
				result.set(token.symbol, {
					amount: balance,
					currency: token.symbol,
					decimals: Number(decimals)
				});
				console.log(`Successfully got balance for ${token.symbol} via JSON-RPC batch`);
			} else {
				console.warn(`Failed to get balance for token ${token.symbol} via JSON-RPC batch - empty result`);
			}
		} catch (error) {
			console.info(`Error processing token balance ${token.symbol} from JSON-RPC batch:`, error instanceof Error ? error.message : String(error));
		}
	}

	console.log(`JSON-RPC batch processed ${result.size}/${tokens.length} token balances successfully`);
	return result;
}

// Special JSON-RPC batch executor for balances (handles different function parameters)
async function executeBatchBalanceCall(tokensWithAddresses: any[], provider: any, network: any, addr: any): Promise<Map<string, IBalance>> {
	const result = new Map<string, IBalance>();

	try {
		// Create batch request payload for JSON-RPC
		const batchPayload: BatchRequestPayload[] = [];
		let id = 1;

		tokensWithAddresses.forEach(token => {
			const contract = new Contract(token.contract_address, erc20BalanceABI, provider);
			// Add balanceOf() call to batch (needs address parameter)
			batchPayload.push({
				jsonrpc: '2.0',
				id: id++,
				method: 'eth_call',
				params: [
					{
						to: token.contract_address,
						data: contract.interface.encodeFunctionData('balanceOf', [addr.address])
					},
					'latest'
				]
			});
			// Add decimals() call to batch (no parameters)
			batchPayload.push({
				jsonrpc: '2.0',
				id: id++,
				method: 'eth_call',
				params: [
					{
						to: token.contract_address,
						data: contract.interface.encodeFunctionData('decimals')
					},
					'latest'
				]
			});
		});

		console.log(`Fallback: Sending JSON-RPC batch with ${batchPayload.length} calls for ${tokensWithAddresses.length} token balances`);

		// Get provider URL
		const providerUrl = getProviderUrl(network);

		// Send single batch JSON-RPC request
		const response = await fetch(providerUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(batchPayload)
		});

		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

		const batchResults = await response.json();
		if (!Array.isArray(batchResults)) throw new Error('Invalid batch response format');

		// Process results
		const contract = new Contract(tokensWithAddresses[0].contract_address, erc20BalanceABI, provider);
		return processTokenBalanceBatchResults(batchResults, tokensWithAddresses, contract);
	} catch (error) {
		console.debug('Error in batch balance call:', error);
	}

	return result;
}

async function fallbackBatchBalanceCall(tokensWithAddresses: any[], provider: any, network: any, addr: any): Promise<Map<string, IBalance>> {
	return executeBatchBalanceCall(tokensWithAddresses, provider, network, addr);
}

// Process token balance results from Multicall
function processTokenBalanceResults(returnData: string[], tokens: any[], erc20Interface: any, additionalParams: any[]): Map<string, IBalance> {
	const result = new Map<string, IBalance>();

	for (let i = 0; i < tokens.length; i++) {
		const balanceIndex = i * 2;
		const decimalsIndex = i * 2 + 1;
		const token = tokens[i];

		try {
			if (returnData[balanceIndex] && returnData[decimalsIndex]) {
				const balance = erc20Interface.decodeFunctionResult('balanceOf', returnData[balanceIndex])[0];
				const decimals = erc20Interface.decodeFunctionResult('decimals', returnData[decimalsIndex])[0];
				result.set(token.symbol, {
					amount: balance,
					currency: token.symbol,
					decimals: Number(decimals)
				});
				console.log(`Successfully got balance for ${token.symbol} via Multicall`);
			} else {
				console.warn(`Failed to get balance for token ${token.symbol} via Multicall - empty response`);
			}
		} catch (error) {
			console.info(`Error processing token balance ${token.symbol} from Multicall:`, error instanceof Error ? error.message : String(error));
		}
	}

	console.log(`Multicall processed ${result.size}/${tokens.length} token balances successfully`);
	return result;
}


// Wrapper for token info Multicall
async function tryMulticall(contractAddresses: string[], provider: any, network: any): Promise<Map<string, {
	name: string;
	symbol: string
}> | null> {
	return executeMulticall(contractAddresses, erc20InfoABI, ['name', 'symbol'], provider, network, [], processTokenInfoResults);
}

// Generic JSON-RPC batch executor
async function executeBatchCall<T>(addresses: string[], abi: string[], functionNames: string[], provider: any, network: any, additionalParams: any[] = [], processor: (batchResults: any[], addresses: string[], contract: Contract) => Map<string, T>): Promise<Map<string, T>> {
	const result = new Map<string, T>();

	try {
		// Create batch request payload for JSON-RPC
		const batchPayload: BatchRequestPayload[] = [];
		let id = 1;

		addresses.forEach(address => {
			const contract = new Contract(address, abi, provider);
			functionNames.forEach(funcName => {
				batchPayload.push({
					jsonrpc: '2.0',
					id: id++,
					method: 'eth_call',
					params: [
						{
							to: address,
							data: contract.interface.encodeFunctionData(funcName, additionalParams)
						},
						'latest'
					]
				});
			});
		});

		console.log(`Fallback: Sending JSON-RPC batch with ${batchPayload.length} calls for ${addresses.length} tokens`);

		// Get provider URL
		const providerUrl = getProviderUrl(network);

		// Send single batch JSON-RPC request
		const response = await fetch(providerUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(batchPayload)
		});

		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

		const batchResults = await response.json();
		if (!Array.isArray(batchResults)) throw new Error('Invalid batch response format');

		// Process results using the provided processor function
		const contract = new Contract(addresses[0], abi, provider); // For decoding
		return processor(batchResults, addresses, contract);
	} catch (error) {
		console.error('Error in batch call:', error);
	}

	return result;
}


// Process token info results from Multicall
function processTokenInfoResults(returnData: string[], addresses: string[], erc20Interface: any): Map<string, {
	name: string;
	symbol: string
}> {
	const result = new Map<string, { name: string; symbol: string }>();

	for (let i = 0; i < addresses.length; i++) {
		const nameIndex = i * 2;
		const symbolIndex = i * 2 + 1;
		const address = addresses[i];

		try {
			if (returnData[nameIndex] && returnData[symbolIndex]) {
				const name = erc20Interface.decodeFunctionResult('name', returnData[nameIndex])[0];
				const symbol = erc20Interface.decodeFunctionResult('symbol', returnData[symbolIndex])[0];
				result.set(address, {
					name: String(name),
					symbol: String(symbol)
				});
			} else {
				console.warn(`Failed to get info for token ${address} via Multicall`);
			}
		} catch (error) {
			console.info(`Error processing token ${address} from Multicall:`, error instanceof Error ? error.message : String(error));
		}
	}

	return result;
}


/**
 * Get token information (name and symbol) for multiple contract addresses in batch
 * @param contractAddresses - Array of contract addresses to get info for
 * @returns Map of contract addresses to token info
 */
export async function getBatchTokensInfo(contractAddresses: ContractAddress[]): Promise<Map<ContractAddress, ITokenLoadedInfo>> {
	const p = get(provider);
	const net = get(selectedNetwork);
	const result = new Map<string, { name: string; symbol: string }>();
	if (!net || !p || contractAddresses.length === 0) {
		console.error('Network, provider not set or no addresses provided');
		return result;
	}
	try {
		// Try Multicall first
		const multicallResult = await tryMulticall(contractAddresses, p, net);
		if (multicallResult && multicallResult.size > 0) {
			// Add successful results to the final result
			multicallResult.forEach((info, address) => {
				result.set(address, info);
			});
			// Check if we got all addresses, if not, try fallback for missing ones
			const missingAddresses = contractAddresses.filter(address => !multicallResult.has(address));
			if (missingAddresses.length === 0) return result; // All addresses successful
			console.log(`Multicall info succeeded for ${multicallResult.size} tokens, trying fallback for ${missingAddresses.length} missing tokens`);
			// Try fallback for missing addresses
			const fallbackResult = await fallbackBatchCall(missingAddresses, p, net);
			if (fallbackResult && fallbackResult.size > 0) {
				fallbackResult.forEach((info, address) => {
					result.set(address, info);
				});
			}
		} else {
			// Multicall completely failed, try fallback for all
			const fallbackResult = await fallbackBatchCall(contractAddresses, p, net);
			if (fallbackResult && fallbackResult.size > 0) {
				fallbackResult.forEach((info, address) => {
					result.set(address, info);
				});
			}
		}
	} catch (error) {
		console.error('Error in batch token info request:', error);
	}
	return result;
}


/**
 * Get token information (name and symbol) for a single contract address
 * @param contractAddress - The contract address to get info for
 * @returns Token info object or null if not found
 */
export async function getTokenInfo(contractAddress: ContractAddress): Promise<ITokenLoadedInfo | null> {
	const batchResult = await getBatchTokensInfo([contractAddress]);
	return batchResult.get(contractAddress) || null;
}

/**
 * Get the decimal places for a token contract
 * @param contractAddress - The contract address to get decimals for
 * @returns Number of decimal places for the token
 */
export async function getTokenDecimals(contractAddress: ContractAddress): Promise<number> {
	const p = get(provider);
	if (!p) {
		console.error('Provider not set');
		return 18; // Fallback
	}
	try {
		const abi = ['function decimals() view returns (uint8)'];
		const contract = new Contract(contractAddress, abi, p);
		const decimals = await contract.decimals();
		return Number(decimals);
	} catch (error) {
		console.error('Error getting token decimals:', error);
		return 18; // Fallback
	}
}


