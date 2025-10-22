import { formatUnits, Contract } from 'ethers';
import { get, writable, derived } from 'svelte/store';
// Removed circular import - this function is defined in this file
import type { Guid, ContractAddress, NftKey } from './types.ts';
import { provider, waitForProviderReady } from './provider.ts';
import { networks, selectedNetwork } from './network.ts';
import { selectedAddress } from './wallet.ts';

/**
 * Generates a unique key for looking up NFT balances based on contract address and token ID.
 * This is used for balance lookups in stores like nftBalances, not for NFT configuration GUIDs.
 * @param contract_address - The NFT contract address
 * @param token_id - The token ID
 * @returns A unique balance key string in format: contract_address_token_id
 */
export function nftBalanceKey(contract_address: string, token_id: string): NftKey {
	return `${contract_address}_${token_id}`;
}

export let nftConfs = derived([selectedNetwork], ([$selectedNetwork]) => {
	return ($selectedNetwork?.nfts || []).map(nft => ({
		guid: nft.guid,
		contract_address: nft.contract_address,
		token_id: nft.token_id,
	}));
});





export interface INftDef {
	contract_address: ContractAddress;
	token_id?: string; // Optional specific token ID for ERC-1155
}


/* items managed by user as part of network config */
export interface INftConf extends INftDef {
	guid: Guid;
}

// NFT-specific balance interface
export interface INftBalance {
	amount: number; // Number of NFTs owned (usually 1 for ERC-721, can be > 1 for ERC-1155)
	timestamp: Date;
}


// Collection-level contract info (name, symbol of the NFT collection)
interface INftCollectionInfo {
	name: string;
	symbol: string;
}


// Individual NFT token metadata loaded from IPFS by tokenURI
interface INftLoadedInfo {
	name: string;
	description?: string;
	image?: string;
	animation_url?: string;
	external_url?: string;
	attributes?: Array<{ trait_type: string; value: string | number }>;
}


// Derived store for display-ready NFT data
export interface INftForDisplay {
	conf: INftConf;
	collectionInfo: INftCollectionInfo | null;
	tokenMetadata: INftLoadedInfo | undefined;
	balance: INftBalance | undefined;
	isLoadingCollection: boolean;
	isLoadingBalance: boolean;
	displayName: string;
	standard: NftStandard | undefined;
}


// Stores
export const nftCollectionInfos = writable<Map<ContractAddress, INftCollectionInfo | null>>(new Map());
export const nftTokenMetadatas = writable<Map<NftKey, INftLoadedInfo>>(new Map());
export const nftBalances = writable<Map<NftKey, INftBalance>>(new Map());
export const nftStandards = writable<Map<ContractAddress, NftStandard>>(new Map());

export const loadingNftCollections = writable<Set<ContractAddress>>(new Set());
export const loadingNftTokens = writable<Set<NftKey>>(new Set());
export const loadingNftBalances = writable<Set<NftKey>>(new Set());

// used to force a "loading" UI indicator immediately on wallet load
const wasEverLoadingNftCollections = writable<Set<ContractAddress>>(new Set());
const wasEverLoadingNftTokens = writable<Set<NftKey>>(new Set());
const wasEverLoadingNftBalances = writable<Set<NftKey>>(new Set());


export const nftsForDisplay = derived(
	[
		nftConfs,
		nftCollectionInfos,
		nftTokenMetadatas,
		nftBalances,
		nftStandards,
		loadingNftCollections,
		loadingNftTokens,
		loadingNftBalances,
		wasEverLoadingNftCollections,
		wasEverLoadingNftTokens,
		wasEverLoadingNftBalances,

	],
	([
		$nftConfs,
		$nftCollectionInfos,
		$nftTokenMetadatas,
		$nftBalances,
		$nftStandards,
		$loadingNftCollections,
		$loadingNftTokens,
		$loadingNftBalances,
		$wasEverLoadingNftCollections,
		$wasEverLoadingNftTokens,
		$wasEverLoadingNftBalances,

	 ]) => {
		return $nftConfs.map(conf => {
			const key = nftBalanceKey(conf.contract_address, conf.token_id || '0');

			const collectionInfo = $nftCollectionInfos.get(conf.contract_address);
			const tokenMetadata = $nftTokenMetadatas.get(key);
			const balance = $nftBalances.get(key);
			const standard = $nftStandards.get(conf.contract_address);

			const isLoadingCollection = $loadingNftCollections.has(conf.contract_address);
			const isLoadingToken = $loadingNftTokens.has(key);
			const isLoadingBalance = $loadingNftBalances.has(key);

			return {
				conf: conf,
				tokenMetadata,
				collectionInfo,
				balance,
				standard,

				isLoadingCollection: isLoadingCollection || !$wasEverLoadingNftCollections.has(conf.contract_address),
				isLoadingToken: isLoadingToken || !$wasEverLoadingNftTokens.has(key),
				isLoadingBalance: isLoadingBalance || !$wasEverLoadingNftBalances.has(key),

				displayName: (collectionInfo?.name || 'NFT') + (conf.token_id ? ` #${conf.token_id}` : '')+ (tokenMetadata?.name ? ` - ${tokenMetadata.name}` : ''),
			} as INftForDisplay;
		});
	}
);



// ERC-721 and ERC-1155 ABIs for NFT operations
// Interface detection
const erc165ABI = ['function supportsInterface(bytes4 interfaceId) view returns (bool)'];
const ERC721_INTERFACE_ID = '0x80ac58cd';
const ERC1155_INTERFACE_ID = '0xd9b67a26';

// Contract ABIs
const erc721ABI = ['function balanceOf(address owner) view returns (uint256)', 'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)', 'function tokenURI(uint256 tokenId) view returns (string)', 'function ownerOf(uint256 tokenId) view returns (address)', 'function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function tokenByIndex(uint256 index) view returns (uint256)'];
// Alternative minimal ABI for contracts that might not support full enumeration
const erc721MinimalABI = ['function balanceOf(address owner) view returns (uint256)', 'function ownerOf(uint256 tokenId) view returns (address)', 'function tokenURI(uint256 tokenId) view returns (string)', 'function name() view returns (string)', 'function symbol() view returns (string)'];
const erc1155ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)', 'function uri(uint256 id) view returns (string)'];

type NftStandard = 'ERC721' | 'ERC1155' | 'UNKNOWN';

/**
 * Detect which NFT standard a contract implements using ERC165
 */
async function detectNftStandard(contractAddress: string, provider: any): Promise<NftStandard> {
	try {
		const contract = new Contract(contractAddress, erc165ABI, provider);
		
		const [isERC721, isERC1155] = await Promise.all([
			contract.supportsInterface(ERC721_INTERFACE_ID),
			contract.supportsInterface(ERC1155_INTERFACE_ID)
		]);
		
		if (isERC721) return 'ERC721';
		if (isERC1155) return 'ERC1155';
		return 'UNKNOWN';
	} catch (error) {
		console.warn(`ERC165 detection failed for ${contractAddress}:`, error);
		return 'UNKNOWN';
	}
}

/**
 * Execute NFT operation with proper standard detection and fallback
 */
async function executeNftOperation<T>(
	configuredNft: INftConf, 
	provider: any, 
	address: string,
	erc721Fn: () => Promise<T>,
	erc1155Fn: () => Promise<T>
): Promise<T | null> {
	const standard = await detectNftStandard(configuredNft.contract_address, provider);
	
	try {
		switch (standard) {
			case 'ERC721':
				return await erc721Fn();
			case 'ERC1155':
				return await erc1155Fn();
			case 'UNKNOWN':
				// Fallback: try ERC721 first, then ERC1155
				try {
					return await erc721Fn();
				} catch {
					return await erc1155Fn();
				}
		}
	} catch (error) {
		console.debug(`Failed NFT operation for ${standard} contract ${configuredNft.contract_address}:`, error instanceof Error ? error.message : error);
		return null;
	}
}




/**
 * Load collection-level info (name, symbol) for NFT contracts
 */
export async function loadNFTCollectionInfos(contractAddresses: string[]): Promise<void> {
	if (!contractAddresses.length) return;
	
	const currentlyLoading = get(loadingNftCollections);
	const currentInfos = get(nftCollectionInfos);
	
	const contractsToLoad = contractAddresses.filter(addr => 
		!currentlyLoading.has(addr) && !currentInfos.has(addr)
	);
	
	if (!contractsToLoad.length) return;
	
	console.log('Loading NFT collection infos for', contractsToLoad.length, 'contracts');

	// Mark as loading
	loadingNftCollections.update(set => {
		contractsToLoad.forEach(addr => set.add(addr));
		return set;
	});
	wasEverLoadingNftCollections.update(set => {
		contractsToLoad.forEach(addr => set.add(addr));
		return set;
	});

	await waitForProviderReady();

	const p = get(provider);
	if (!p) {
		loadingNftCollections.update(set => {
			contractsToLoad.forEach(addr => set.delete(addr));
			return set;
		});
		throw new Error('Provider not available for loading NFT collection info');
	}
	
	const results = await Promise.allSettled(
		contractsToLoad.map(async (contractAddress) => {
			const contract = new Contract(contractAddress, erc721ABI, p);
			const [name, symbol, standard] = await Promise.all([
				contract.name(),
				contract.symbol(),
				detectNftStandard(contractAddress, p)
			]);
			return { contractAddress, info: { name, symbol }, standard };
		})
	);

	// Update stores
	nftCollectionInfos.update(map => {
		results.forEach((result, index) => {
			const contractAddress = contractsToLoad[index];
			if (result.status === 'fulfilled') {
				map.set(contractAddress, result.value.info);
			} else {
				console.warn(`Failed to load collection info for ${contractAddress}:`, result.reason);
				map.set(contractAddress, null);
			}
		});
		return map;
	});

	nftStandards.update(map => {
		results.forEach((result, index) => {
			const contractAddress = contractsToLoad[index];
			if (result.status === 'fulfilled') {
				map.set(contractAddress, result.value.standard);
			}
		});
		return map;
	});

	loadingNftCollections.update(set => {
		contractsToLoad.forEach(addr => set.delete(addr));
		return set;
	});
}

/**
 * Enumerate all ERC721 tokens owned by an address from a specific contract
 * This is useful for UI features that want to show all owned NFTs from a collection
 * 
 * @param contractAddress - The NFT contract address
 * @param provider - Ethereum provider for blockchain calls
 * @param address - User's wallet address
 * @param maxTokens - Maximum number of tokens to enumerate (default 50, max 100)
 * @returns Array of token IDs owned by the address, or null if enumeration not supported
 */
export async function enumerateOwnedErc721Tokens(
	contractAddress: string, 
	provider: any, 
	address: string, 
	maxTokens: number = 50
): Promise<string[] | null> {
	const contract = new Contract(contractAddress, erc721ABI, provider);
	
	// Check how many NFTs the user owns
	const balance = Number(await contract.balanceOf(address));
	if (balance === 0) return [];
	
	// Limit enumeration to prevent excessive gas usage
	const tokensToEnum = Math.min(balance, Math.min(maxTokens, 100));
	
	try {
		const tokenIds: string[] = [];
		for (let i = 0; i < tokensToEnum; i++) {
			const tokenId = await contract.tokenOfOwnerByIndex(address, i);
			tokenIds.push(tokenId.toString());
		}
		return tokenIds;
	} catch (enumError) {
		// Contract doesn't support tokenOfOwnerByIndex enumeration
		console.warn(`Contract ${contractAddress} doesn't support token enumeration`);
		return null;
	}
}

/**
 * Get ERC721 NFT balance for a specific token
 */
async function getErc721Balance(configuredNft: INftConf, provider: any, address: string): Promise<number> {
	if (!configuredNft.token_id) return 0;
	
	const contract = new Contract(configuredNft.contract_address, erc721ABI, provider);
	const owner = await contract.ownerOf(configuredNft.token_id);
	return owner.toLowerCase() === address.toLowerCase() ? 1 : 0;
}

/**
 * Get ERC1155 NFT balance for a specific token
 */
async function getErc1155Balance(configuredNft: INftConf, provider: any, address: string): Promise<number> {
	if (!configuredNft.token_id) return 0;
	
	const contract = new Contract(configuredNft.contract_address, erc1155ABI, provider);
	const balance = await contract.balanceOf(address, configuredNft.token_id);
	return Number(balance);
}

/**
 * Create NFT metadata object from fetched metadata and token ID
 */
function createNftMetadataObject(metadata: any, tokenId: string, defaultName: string): INftLoadedInfo {
	return {
		name: metadata.name || defaultName,
		description: metadata.description,
		image: metadata.image,
		animation_url: metadata.animation_url,
		external_url: metadata.external_url,
		attributes: metadata.attributes
	};
}

/**
 * Load ERC721 NFT metadata for a specific configured NFT
 * Requires token_id to be specified - no fallback to arbitrary tokens
 * 
 * @param configuredNft - The NFT configuration (must include token_id)
 * @param provider - Ethereum provider for blockchain calls
 * @param address - User's wallet address to verify ownership
 * @returns NFT metadata if owned, null if not owned or token_id missing
 */
async function loadErc721Metadata(configuredNft: INftConf, provider: any, address: string): Promise<INftLoadedInfo | null> {
	// ERC721 tracking requires specific token ID
	if (!configuredNft.token_id) {
		console.warn(`loadErc721Metadata: ERC721 NFT ${configuredNft.contract_address} requires token_id to be specified`);
		return null;
	}
	
	const contract = new Contract(configuredNft.contract_address, erc721ABI, provider);
	const tokenURI = await contract.tokenURI(configuredNft.token_id);
	const metadata = tokenURI ? await fetchNFTMetadata(tokenURI) : {};
	
	return createNftMetadataObject(metadata, configuredNft.token_id, `NFT #${configuredNft.token_id}`);
}

/**
 * Process ERC1155 URI template by replacing {id} placeholder with token ID
 */
function processErc1155Uri(uriTemplate: string, tokenId: string): string {
	// Replace {id} with the decimal token ID number
	return uriTemplate.replace('{id}', tokenId);
}

/**
 * Load ERC1155 NFT metadata for a specific configured NFT
 * ERC1155 tokens can be fungible or non-fungible - requires specific token ID
 * 
 * @param configuredNft - The NFT configuration (must include token_id for ERC1155)
 * @param provider - Ethereum provider for blockchain calls  
 * @param address - User's wallet address to check balance
 * @returns NFT metadata if balance > 0, null if no balance or no token_id
 */
async function loadErc1155Metadata(configuredNft: INftConf, provider, address): Promise<INftLoadedInfo | null> {
	// ERC1155 requires specific token ID - can't enumerate like ERC721
	if (!configuredNft.token_id) return null;

	const contract = new Contract(configuredNft.contract_address, erc1155ABI, provider);
	const uriTemplate = await contract.uri(configuredNft.token_id);
	console.log(`loadErc1155Metadata: URI template for token ID ${configuredNft.token_id} is ${uriTemplate}`);
	
	// Replace {id} placeholder with actual token ID in hex format
	const tokenURI = processErc1155Uri(uriTemplate, configuredNft.token_id);
	console.log(`loadErc1155Metadata: processed URI is ${tokenURI}`);
	
	const metadata = tokenURI ? await fetchNFTMetadata(tokenURI) : {};
	
	return createNftMetadataObject(metadata, configuredNft.token_id, `Token #${configuredNft.token_id}`);
}

/**
 * Load metadata for a single NFT, trying ERC721 first then ERC1155
 * This handles the common case where we don't know the contract standard
 * 
 * @param configuredNft - The NFT configuration from user settings
 * @param provider - Ethereum provider for blockchain calls
 * @param address - User's wallet address
 * @returns NFT metadata if found and owned, null otherwise
 */
async function loadSingleNftMetadata(configuredNft: INftConf, provider: any, address: string): Promise<INftLoadedInfo | null> {
	await waitForProviderReady();
	
	return await executeNftOperation(
		configuredNft,
		provider,
		address,
		() => loadErc721Metadata(configuredNft, provider, address),
		() => loadErc1155Metadata(configuredNft, provider, address)
	);
}

/**
 * Load individual NFT token metadata directly from blockchain
 * This is the main entry point for loading NFT metadata into the store
 * 
 * @param nftItems - Array of configured NFTs to load metadata for
 */
export async function loadNFTTokenMetadata(nftItems: INftConf[]): Promise<void> {
	if (!nftItems.length) return;

	// Filter out NFTs we're already loading or have already loaded
	const currentlyLoading = get(loadingNftTokens);
	const currentMetadata = get(nftTokenMetadatas);

	const tokensToLoad = nftItems.filter(nft => {
		const key = nftBalanceKey(nft.contract_address, nft.token_id || '0');
		return !currentlyLoading.has(key) && !currentMetadata.has(key);
	});

	if (!tokensToLoad.length) return;

	console.log('Loading NFT token metadata for', tokensToLoad.length, 'tokens');

	// Mark these NFTs as currently loading to prevent duplicate requests
	loadingNftTokens.update(set => {
		tokensToLoad.forEach(nft => {
			const key = nftBalanceKey(nft.contract_address, nft.token_id || '0');
			set.add(key);
		});
		return set;
	});
	wasEverLoadingNftTokens.update(set => {
		tokensToLoad.forEach(nft => {
			const key = nftBalanceKey(nft.contract_address, nft.token_id || '0');
			set.add(key);
		});
		return set;
	});

	await waitForProviderReady();

	// Get provider and user address for blockchain calls
	const p = get(provider);
	const addr = get(selectedAddress);

	if (!p || !addr) {
		// Clean up loading state if we can't proceed
		loadingNftTokens.update(set => {
			tokensToLoad.forEach(nft => {
				const key = nftBalanceKey(nft.contract_address, nft.token_id || '0');
				set.delete(key);
			});
			return set;
		});
		console.warn('Provider or address not available for loading NFT metadata');
		return;
	}

	// Load metadata for all NFTs in parallel
	const results = await Promise.allSettled(
		tokensToLoad.map(async (configuredNft) => {
			const metadata = await loadSingleNftMetadata(configuredNft, p, addr.address);
			const key = nftBalanceKey(configuredNft.contract_address, configuredNft.token_id || '0');
			return metadata ? { key, metadata } : null;
		})
	);

	console.log('Finished loading NFT metadata: ', results);

	// Update the metadata store with successful results
	nftTokenMetadatas.update(map => {
		results.forEach((result) => {
			if (result.status === 'fulfilled' && result.value) {
				map.set(result.value.key, result.value.metadata);
			}
		});
		return map;
	});

	// Clean up loading state
	loadingNftTokens.update(set => {
		tokensToLoad.forEach(nft => {
			const key = nftBalanceKey(nft.contract_address, nft.token_id || '0');
			set.delete(key);
		});
		return set;
	});
}

/**
 * Load NFT balances for multiple NFT configurations
 * @param nftItems - Array of configured NFTs to load balances for
 */
export async function loadNFTBalances(nftItems: INftConf[]): Promise<void> {
	if (!nftItems.length) return;

	await waitForProviderReady();

	console.log('Loading NFT balances for', nftItems.length, 'NFTs');

	// Load balances in parallel - refreshNftBalance handles deduplication
	await Promise.all(
		nftItems.map(nft => refreshNftBalance(nft))
	);
}

/**
 * Load both collection info, token metadata, and balances
 */
export async function loadNFTsData(nftItems: INftConf[]): Promise<void> {
	if (!nftItems.length) return;
	
	const contractAddresses = [...new Set(nftItems.map(nft => nft.contract_address))];


	await waitForProviderReady();

	console.log('Loading NFT data for', nftItems.length, 'items and ', contractAddresses.length, 'contract addresses');

	// await Promise.all([
	// 	loadNFTCollectionInfos(contractAddresses),
	// 	loadNFTTokenMetadata(nftItems),
	// 	loadNFTBalances(nftItems)
	// ]);
	await loadNFTCollectionInfos(contractAddresses);
	await loadNFTTokenMetadata(nftItems);
	await loadNFTBalances(nftItems);
}


/**
 * Fetch NFT metadata from a token URI (usually IPFS)
 * Handles IPFS URL conversion and image URL processing
 * 
 * @param tokenURI - The token URI from the NFT contract
 * @returns Partial metadata object with name, description, image, etc.
 */
async function fetchNFTMetadata(tokenURI: string): Promise<Partial<INftLoadedInfo>> {
	try {
		console.log(`    🔗 Original token URI:`, tokenURI);

		// Handle IPFS URLs - remove multiple ipfs:// or ipfs/ prefixes
		if (tokenURI.startsWith('ipfs://')) {
			tokenURI = tokenURI.replace('ipfs://', 'https://dweb.link/ipfs/');
		}
		// Handle case where URI already contains ipfs/ but we added another one - fixme
		tokenURI = tokenURI.replace('ipfs/ipfs/', 'ipfs/');

		console.log(`    🔗 Processed token URI:`, tokenURI);

		const response = await fetch(tokenURI);
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const metadata = await response.json();
		console.log(`    📋 Fetched metadata:`, metadata);

		// Handle IPFS URLs in image field with the same logic
		if (metadata.image && metadata.image.startsWith('ipfs://')) {
			metadata.image = metadata.image.replace('ipfs://', 'https://dweb.link/ipfs/');
			// Fix double ipfs/ in image URL too
			//metadata.image = metadata.image.replace('/ipfs/ipfs/', '/ipfs/');
		}

		console.log(`    📋 Processed image URL:`, metadata.image);

		return {
			name: metadata.name,
			description: metadata.description,
			image: metadata.image,

			animation_url: metadata.animation_url,
			external_url: metadata.external_url,
			attributes: metadata.attributes
		};
	} catch (error) {
		console.debug('Failed to fetch NFT metadata from', tokenURI, ':', error instanceof Error ? error.message : error);
		return {};
	}
}


// Clean up old NFT data that's no longer configured
function cleanupOldNftData(currentConfigs: INftConf[]) {
	const currentKeys = new Set(currentConfigs.map(conf => nftBalanceKey(conf.contract_address, conf.token_id || '0')));
	const currentContracts = new Set(currentConfigs.map(conf => conf.contract_address));

	// Clean up metadata and balances for removed NFTs
	nftTokenMetadatas.update(map => {
		const newMap = new Map();
		for (const [key, data] of map.entries()) {
			if (currentKeys.has(key)) {
				newMap.set(key, data);
			}
		}
		return newMap;
	});

	nftBalances.update(map => {
		const newMap = new Map();
		for (const [key, data] of map.entries()) {
			if (currentKeys.has(key)) {
				newMap.set(key, data);
			}
		}
		return newMap;
	});

	// Clean up collection info and standards for unused contracts
	nftCollectionInfos.update(map => {
		const newMap = new Map();
		for (const [contract, data] of map.entries()) {
			if (currentContracts.has(contract)) {
				newMap.set(contract, data);
			}
		}
		return newMap;
	});

	nftStandards.update(map => {
		const newMap = new Map();
		for (const [contract, data] of map.entries()) {
			if (currentContracts.has(contract)) {
				newMap.set(contract, data);
			}
		}
		return newMap;
	});
}

// Load NFT data when configurations change
nftConfs.subscribe(async (configs) => {
	console.log('NFT configurations changed:', configs.length);
	cleanupOldNftData(configs);
	if (configs.length > 0) {
		await loadNFTsData(configs);
	}
});

/**
 * Refresh NFT balance for a specific NFT configuration
 * @param configuredNft - The NFT configuration to refresh
 */
export async function refreshNftBalance(configuredNft: INftConf): Promise<void> {
	const key = nftBalanceKey(configuredNft.contract_address, configuredNft.token_id || '0');

	// Skip if already loading
	const currentlyLoading = get(loadingNftBalances);
	if (currentlyLoading.has(key)) {
		return;
	}

	const p = get(provider);
	const addr = get(selectedAddress);

	if (!p || !addr) {
		console.warn('Provider or address not available for refreshing NFT balance');
		return;
	}

	// Mark as loading
	loadingNftBalances.update(set => {
		set.add(key);
		return set;
	});
	wasEverLoadingNftBalances.update(set => {
		set.add(key);
		return set;
	});

	await waitForProviderReady();

	try {
		let amount: number | null = null;

		console.log(`refreshNftBalance: Refreshing balance for NFT at contract ${configuredNft.contract_address} with token ID ${configuredNft.token_id || 'N/A'}`);

		if (configuredNft.token_id) {
			amount = await executeNftOperation(
				configuredNft,
				p,
				addr.address,
				() => getErc721Balance(configuredNft, p, addr.address),
				() => getErc1155Balance(configuredNft, p, addr.address)
			);

			if (amount !== null) {
				console.log(`    Balance success: User ${addr.address} owns ${amount} of token ${configuredNft.token_id}`);
			}
		}

		// Only update balance store if we successfully got a balance
		if (amount !== null) {
			nftBalances.update(map => {
				const newMap = new Map(map);
				newMap.set(key, {
					amount,
					timestamp: new Date()
				});
				return newMap;
			});
		}

	} finally {
		// Clean up loading state
		loadingNftBalances.update(set => {
			set.delete(key);
			return set;
		});
	}
}

/**
 * Get NFT balance for a specific contract address and token ID
 * Similar to getTokenBalanceByAddress but for NFTs
 * @param contractAddress - The NFT contract address  
 * @param tokenId - The specific token ID
 * @returns IBalance object with NFT balance or null if not found
 */
export async function getNftBalanceByAddress(contractAddress: string, tokenId: string): Promise<{ amount: bigint; currency: string; decimals: number } | null> {
	await waitForProviderReady();

	const p = get(provider);
	const addr = get(selectedAddress);

	if (!p || !addr || !tokenId) {
		return null;
	}

	try {
		// Create a temporary NFT config for the balance check
		const tempNftConf: INftConf = {
			guid: `temp-${contractAddress}-${tokenId}`,
			contract_address: contractAddress,
			token_id: tokenId
		};

		const amount = await executeNftOperation(
			tempNftConf,
			p,
			addr.address,
			() => getErc721Balance(tempNftConf, p, addr.address),
			() => getErc1155Balance(tempNftConf, p, addr.address)
		);

		if (amount !== null) {
			return {
				amount: BigInt(amount),
				currency: `NFT-${contractAddress}-${tokenId}`,
				decimals: 0 // NFTs are always integers
			};
		}

		return null;
	} catch (error) {
		console.error('Error getting NFT balance:', error);
		return null;
	}
}

