import { get, writable, derived } from 'svelte/store';
import { localStorageSharedStore } from './utils/svelte-shared-store';
import { getGuid } from './utils/utils';
import { defaultNetworks } from './default-networks';
import type { INetwork, IToken, ICurrency, IRPCServer, INFT, INFTData, INetworkStatus, IDefaultNetwork } from './types';

// Re-export types for backward compatibility
export type { INetwork, IToken, ICurrency, IRPCServer, INFT, INFTData, INetworkStatus, IDefaultNetwork } from './types';

export const default_networks = writable<INetwork[]>(
	defaultNetworks.map(network => ({
			...network,
			guid: getGuid(),
			tokens: network.tokens || [],
		})));

export const networks = localStorageSharedStore<INetwork[]>('networks', []);
export const selectedNetworkID = localStorageSharedStore<string | null>('selectedNetworkID', null);
export const selectedNetwork = writable<INetwork | undefined>();
export const tokenInfos = writable<Map<string, { name: string; symbol: string } | null>>(new Map());


networks.subscribe((nets: INetwork[]) => {
	let modified = false;
	for (let net of nets) {
		if (net.guid === undefined) {
			net.guid = getGuid();
			modified = true;
		}
		if (net.tokens === undefined) {
			net.tokens = [];
			modified = true;
		}
		if (net.nfts === undefined) {
			net.nfts = [];
			modified = true;
		}
		// If selectedRpcUrl is not in the list of rpcURLs, remove it
		if (net.selectedRpcUrl && net.rpcURLs && !net.rpcURLs.includes(net.selectedRpcUrl)) {
			net.selectedRpcUrl = undefined;
			modified = true;
		}
		for (let token of net.tokens) {
			if (token.guid === undefined) {
				token.guid = getGuid();
				modified = true;
			}
		}
		for (let nft of net.nfts) {
			if (nft.guid === undefined) {
				nft.guid = getGuid();
				modified = true;
			}
		}
	}
	if (modified) {
		setTimeout(() => {
			networks.update(n => n);
		}, 100);
	}
});

selectedNetworkID.subscribe((value: string | null) => {
	updateSelectedNetwork(value, get(networks));
});

networks.subscribe((value: INetwork[]) => {
	updateSelectedNetwork(get(selectedNetworkID), value);
});

function updateSelectedNetwork(selectedNetworkID: string | null, networks: INetwork[]): void {
	const r = networks.find(n => n.guid === selectedNetworkID);
	if (r === get(selectedNetwork)) return;
	/* TODO: check if this is needed
	hasInitializedBalance = false;
	*/
	selectedNetwork.set(r);
}

export function addNetwork(net: INetwork): boolean {
	if (get(networks)?.find(n => n.name === net.name)) return false;
	const my_net: INetwork = {
		guid: getGuid(),
		name: net.name,
		chainID: net.chainID,
		currency: {
			...(net.currency.symbol && { symbol: net.currency.symbol }),
			...(net.currency.iconURL && { iconURL: net.currency.iconURL }),
		},
		explorerURL: net.explorerURL,
		rpcURLs: net.rpcURLs?.map(url => url),
		tokens: [],
	};
	networksAdd(my_net);
	return true;
}

export function editNetwork(net: INetwork): void {
	networks.update(networks => {
		const index = networks.findIndex(n => n.guid === net.guid);
		if (index !== -1) networks[index] = net;
		return networks;
	});
}

export function deleteNetwork(net: INetwork): void {
	console.log('Deleting network:', net);
	console.log('Current networks:', get(networks));
	networks.update(n => {
		return n.filter(item => {
			//console.log('Checking network:', item.guid, 'against', net.guid);
			return item.guid !== net.guid;
		});
	});
}

export function addToken(networkGuid: string, token: IToken): void {
	networks.update(networks => {
		return networks.map(network => {
			if (network.guid === networkGuid) {
				return {
					...network,
					tokens: [...(network.tokens || []), token],
				};
			}
			return network;
		});
	});
}

export function editToken(networkGuid: string, token: IToken): void {
	networks.update(networks => {
		return networks.map(network => {
			if (network.guid === networkGuid) {
				return {
					...network,
					tokens: network.tokens?.map(t => (t.guid === token.guid ? token : t)) || [],
				};
			}
			return network;
		});
	});
}

export let tokens = derived([selectedNetwork], ([$selectedNetwork]) => {
	return ($selectedNetwork?.tokens || []).map(token => ({
		guid: token.guid,
		contract_address: token.item?.contract_address,
		iconURL: token.item?.iconURL,
	}));
});

export let nfts = derived([selectedNetwork], ([$selectedNetwork]) => {
	return ($selectedNetwork?.nfts || []).map(nft => ({
		guid: nft.guid,
		contract_address: nft.item?.contract_address,
		token_id: nft.item?.token_id,
		name: nft.item?.name,
		description: nft.item?.description,
		image: nft.item?.image,
		animation_url: nft.item?.animation_url,
		external_url: nft.item?.external_url,
		attributes: nft.item?.attributes,
	}));
});

export let currencies = derived([selectedNetwork, tokens, tokenInfos], ([$selectedNetwork, $tokens, $tokenInfos]) => {
	const currencyList: ICurrency[] = [];
	// Add native currency
	if ($selectedNetwork?.currency?.symbol) {
		currencyList.push({
			symbol: $selectedNetwork.currency.symbol,
			iconURL: $selectedNetwork.currency.iconURL,
		});
	}
	// Add tokens
	if ($tokens && $tokens.length > 0) {
		$tokens.forEach(token => {
			if (token.contract_address) {
				const tokenInfo = $tokenInfos.get(token.contract_address);
				const symbol = tokenInfo?.symbol || token.contract_address.slice(0, 8) + '...';
				currencyList.push({
					symbol: symbol,
					iconURL: token.iconURL,
					contract_address: token.contract_address,
				});
			}
		});
	}
	return currencyList;
});

export function deleteToken(networkGuid: string, tokenGuid: string): void {
	networks.update(networks => {
		return networks.map(network => {
			if (network.guid === networkGuid) {
				return {
					...network,
					tokens: (network.tokens || []).filter(t => t.guid !== tokenGuid),
				};
			}
			return network;
		});
	});
}

export function updateTokenInfo(contractAddress: string, tokenInfo: { name: string; symbol: string } | null): void {
	tokenInfos.update(map => {
		const newMap = new Map(map);
		newMap.set(contractAddress, tokenInfo);
		return newMap;
	});
}

export function reorderTokens(networkGuid: string, reorderedTokens: IToken[]): void {
	networks.update(networks => {
		return networks.map(network => {
			if (network.guid === networkGuid) {
				return {
					...network,
					tokens: reorderedTokens,
				};
			}
			return network;
		});
	});
}

export function setSelectedRpcUrl(networkGuid: string, rpcUrl: string): void {
	networks.update(networks => {
		return networks.map(network => {
			if (network.guid === networkGuid) {
				return {
					...network,
					selectedRpcUrl: rpcUrl,
				};
			}
			return network;
		});
	});
}

export function getSelectedRpcUrl(network: INetwork): string | undefined {
	// Return stored selected RPC URL even if it's not in the valid list anymore
	// This allows keeping user's selection of non-functional servers for testing
	if (network.selectedRpcUrl) return network.selectedRpcUrl;
	// Otherwise return the first available RPC URL
	return network.rpcURLs?.[0];
}


export function generateUniqueNetworkName(baseName: string): string {
	const existingNetworks = get(networks);
	let counter = 1;
	let newName = `${baseName} (${counter})`;
	while (existingNetworks.find(n => n.name === newName)) {
		counter++;
		newName = `${baseName} (${counter})`;
	}
	return newName;
}

export function replaceAllNetworks(networksData: any[]): void {
	const networksWithGuids = networksData.map((network: any) => {
		if (!network.guid) return { ...network, guid: getGuid() };
		return network;
	});
	networks.set(networksWithGuids);
}

export function addNetworkIfNotExists(network: any): boolean {
	const existingNetworks = get(networks);
	const exists = existingNetworks.find(n => n.name === network.name);
	if (!exists) {
		if (!network.guid) network.guid = getGuid();
		networksAdd(network);
		return true;
	}
	return false;
}

export function replaceExistingNetwork(networkToReplace: any): void {
	networks.update(current => {
		return current.map(network => {
			if (network.name === networkToReplace.name) return { ...networkToReplace, guid: network.guid };
			return network;
		});
	});
}

export function addNetworkWithUniqueName(network: any): void {
	const uniqueName = generateUniqueNetworkName(network.name);
	const networkWithUniqueName = { ...network, name: uniqueName, guid: getGuid() };
	networksAdd(networkWithUniqueName);
}

export function hasNetworkWithName(name: string): boolean {
	return get(networks).some(n => n.name === name);
}

export function addSingleNetwork(network: any): void {
	if (!network.guid) network.guid = getGuid();
	networksAdd(network);
}

export function findNetworkByName(name: string): any | undefined {
	const existingNetworks = get(networks);
	return existingNetworks.find(n => n.name === name);
}

export function findNetworkByGuid(guid: string): INetwork | undefined {
	const existingNetworks = get(networks);
	return existingNetworks.find(n => n.guid === guid);
}

export function checkIfNetworksExist(): boolean {
	return get(networks).length > 0;
}

export async function checkRPCServer(server: IRPCServer): Promise<void> {
	server.checking = true;
	const startTime = Date.now();
	try {
		const isWebSocket = server.url.startsWith('ws://') || server.url.startsWith('wss://');
		if (isWebSocket) await checkWebSocketRPCServer(server, startTime);
		else await checkHTTPRPCServer(server, startTime);
	} catch (error) {
		console.info('Error checking RPC server ' + server.url + ':', (error as Error)?.message);
		server.latency = null;
		server.lastBlock = null;
		server.blockAge = null;
		server.isAlive = false;
	} finally {
		server.checking = false;
	}
}

// Helper function to make RPC calls with proper timeout handling
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
	if (typeof AbortSignal.timeout === 'function') {
		// Modern browsers - use native implementation
		return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
	} else {
		// Fallback for older browsers
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetch(url, { ...options, signal: controller.signal });
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

async function checkHTTPRPCServer(server: IRPCServer, startTime: number): Promise<void> {
	const blockNumberResponse = await fetchWithTimeout(server.url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'eth_blockNumber',
			params: [],
			id: 1,
		}),
	}, 10000);
	
	if (!blockNumberResponse.ok) throw new Error('HTTP ' + blockNumberResponse.status + ': ' + blockNumberResponse.statusText);
	const blockNumberData = await blockNumberResponse.json();
	if (blockNumberData.error) throw new Error('RPC Error: ' + blockNumberData.error.message);
	const blockNumber = parseInt(blockNumberData.result, 16);
	let blockAge: number | null = null;
	
	try {
		const blockResponse = await fetchWithTimeout(server.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'eth_getBlockByNumber',
				params: [blockNumberData.result, false],
				id: 2,
			}),
		}, 5000);
		
		if (blockResponse.ok) {
			const blockData = await blockResponse.json();
			if (!blockData.error && blockData.result && blockData.result.timestamp) {
				const blockTimestamp = parseInt(blockData.result.timestamp, 16);
				const currentTime = Math.floor(Date.now() / 1000);
				blockAge = currentTime - blockTimestamp;
			}
		}
	} catch (blockError) {
		console.info('Could not get block details for ' + server.url + ':', blockError);
	}
	
	const endTime = Date.now();
	server.latency = endTime - startTime;
	server.lastBlock = blockNumber;
	server.blockAge = blockAge;
	server.isAlive = true;
}

async function checkWebSocketRPCServer(server: IRPCServer, startTime: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const ws = new WebSocket(server.url);
		let resolved = false;
		let blockNumber: number | null = null;
		let blockAge: number | null = null;
		const cleanup = () => {
			if (ws.readyState === WebSocket.OPEN) ws.close();
		};
		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				cleanup();
				reject(new Error('WebSocket connection timeout'));
			}
		}, 10000);
		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					jsonrpc: '2.0',
					method: 'eth_blockNumber',
					params: [],
					id: 1,
				})
			);
		};
		ws.onmessage = async event => {
			try {
				const data = JSON.parse(event.data);
				if (data.id === 1) {
					if (data.error) throw new Error('RPC error: ' + data.error.message);
					blockNumber = parseInt(data.result, 16);
					ws.send(
						JSON.stringify({
							jsonrpc: '2.0',
							method: 'eth_getBlockByNumber',
							params: [data.result, false],
							id: 2,
						})
					);
				} else if (data.id === 2) {
					if (!data.error && data.result && data.result.timestamp) {
						const blockTimestamp = parseInt(data.result.timestamp, 16);
						const currentTime = Math.floor(Date.now() / 1000);
						blockAge = currentTime - blockTimestamp;
					}
					if (!resolved) {
						resolved = true;
						clearTimeout(timeout);
						const endTime = Date.now();
						server.latency = endTime - startTime;
						server.lastBlock = blockNumber;
						server.blockAge = blockAge;
						server.isAlive = true;
						cleanup();
						resolve();
					}
				}
			} catch (error) {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					cleanup();
					reject(error);
				}
			}
		};
		ws.onerror = error => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				cleanup();
				reject(new Error('WebSocket error: ' + error));
			}
		};
		ws.onclose = event => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				if (event.code !== 1000) reject(new Error('WebSocket closed with code ' + event.code + ': ' + event.reason));
			}
		};
	});
}

export async function checkAllRPCServers(servers: IRPCServer[]): Promise<void> {
	const promises = servers.map(server => checkRPCServer(server));
	await Promise.all(promises);
}

export function formatLatency(latency: number | null): string {
	if (latency === null) return 'N/A';
	return latency + 'ms';
}

export function formatBlockNumber(blockNumber: number | null): string {
	if (blockNumber === null) return 'N/A';
	return blockNumber.toLocaleString();
}

export function formatBlockAge(blockAge: number | null): string {
	if (blockAge === null) return 'N/A';
	if (blockAge < 60) return blockAge + 's ago';
	else if (blockAge < 3600) {
		const minutes = Math.floor(blockAge / 60);
		return minutes + 'm ago';
	} else if (blockAge < 86400) {
		const hours = Math.floor(blockAge / 3600);
		const minutes = Math.floor((blockAge % 3600) / 60);
		return hours + 'h ' + minutes + 'm ago';
	} else {
		const days = Math.floor(blockAge / 86400);
		const hours = Math.floor((blockAge % 86400) / 3600);
		return days + 'd ' + hours + 'h ago';
	}
}

export function getRPCServersFromNetwork(network: INetwork): IRPCServer[] {
	if (!network?.rpcURLs) return [];
	return network.rpcURLs.map(url => ({
		url,
		latency: null,
		lastBlock: null,
		blockAge: null,
		isAlive: false,
		checking: false,
	}));
}

export function reorderNetworks(reorderedNetworks: INetwork[]): void {
	networks.set(reorderedNetworks);
}

export function addNFT(networkGuid: string, nftData: INFTData): void {
	networks.update(nets => {
		const net = nets.find(n => n.guid === networkGuid);
		if (!net) return nets;
		if (!net.nfts) net.nfts = [];
		const newNft: INFT = {
			guid: getGuid(),
			item: nftData,
		};
		net.nfts.push(newNft);
		return nets;
	});
}

export function deleteNFT(networkGuid: string, nftGuid: string): void {
	networks.update(nets => {
		const net = nets.find(n => n.guid === networkGuid);
		if (!net?.nfts) return nets;
		net.nfts = net.nfts.filter(nft => nft.guid !== nftGuid);
		return nets;
	});
}

export function editNFT(networkGuid: string, nftGuid: string, nftData: INFTData): void {
	networks.update(nets => {
		const net = nets.find(n => n.guid === networkGuid);
		if (!net?.nfts) return nets;
		const nft = net.nfts.find(n => n.guid === nftGuid);
		if (nft) {
			nft.item = nftData;
		}
		return nets;
	});
}

export function reorderNFTs(networkGuid: string, reorderedNFTs: INFT[]): void {
	networks.update(networks => {
		return networks.map(network => {
			if (network.guid === networkGuid) {
				return {
					...network,
					nfts: reorderedNFTs,
				};
			}
			return network;
		});
	});
}


export function networksAdd(net: INetwork): void {
	networks.update(n => {
		n.push(net);
		return n;
	});
	console.log('Added network:', net);
	console.log('get(selectedNetworkID):', get(selectedNetworkID));
	if (!get(selectedNetworkID))
	{
		console.log('Setting selectedNetworkID to new network');
		selectedNetworkID.set(net.guid??null);
	}
}


networks.subscribe((nets: INetwork[]) => {
	if (!nets.find(n => n.guid === get(selectedNetworkID))) {
		if (nets.length > 0) selectedNetworkID.set(nets[0].guid ?? null);
		else selectedNetworkID.set(null);
	}
});