import { formatUnits, Contract } from 'ethers';
import { get, writable, derived } from 'svelte/store';
// Removed circular import - this function is defined in this file
import type { Guid, ContractAddress } from './types.ts';
import { provider } from './provider.ts';
import { nftConfs, selectedNetwork } from './network.ts';

// Re-export for external use
export { nftConfs };
import { selectedAddress } from './wallet.ts';






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




// Stores
export const nftCollectionInfos = writable<Map<ContractAddress, INftCollectionInfo | null>>(new Map());
export const nftTokenMetadatas = writable<Map<Guid, INftLoadedInfo>>(new Map());
export const nftBalances = writable<Map<Guid, INftBalance>>(new Map());
export const loadingNftCollections = writable<Set<ContractAddress>>(new Set());
export const loadingNftTokens = writable<Set<Guid>>(new Set());
export const loadingNftBalances = writable<Set<Guid>>(new Set());



// ERC-721 and ERC-1155 ABIs for NFT operations
const erc721ABI = ['function balanceOf(address owner) view returns (uint256)', 'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)', 'function tokenURI(uint256 tokenId) view returns (string)', 'function ownerOf(uint256 tokenId) view returns (address)', 'function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function tokenByIndex(uint256 index) view returns (uint256)'];
// Alternative minimal ABI for contracts that might not support full enumeration
const erc721MinimalABI = ['function balanceOf(address owner) view returns (uint256)', 'function ownerOf(uint256 tokenId) view returns (address)', 'function tokenURI(uint256 tokenId) view returns (string)', 'function name() view returns (string)', 'function symbol() view returns (string)'];
const erc1155ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)', 'function uri(uint256 id) view returns (string)'];




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
			const [name, symbol] = await Promise.all([
				contract.name(),
				contract.symbol()
			]);
			return { contractAddress, info: { name, symbol } };
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
		console.warn(`ERC721 NFT ${configuredNft.contract_address} requires token_id to be specified`);
		return null;
	}
	
	const contract = new Contract(configuredNft.contract_address, erc721ABI, provider);
	
	// Verify user owns this specific token
	try {
		const owner = await contract.ownerOf(configuredNft.token_id);
		if (owner.toLowerCase() !== address.toLowerCase()) {
			console.warn(`User ${address} does not own token ${configuredNft.token_id} from ${configuredNft.contract_address}`);
			return null;
		}
	} catch (error) {
		console.warn(`Token ${configuredNft.token_id} does not exist in contract ${configuredNft.contract_address}`);
		return null;
	}
	
	// User owns this specific token - get its metadata
	const tokenURI = await contract.tokenURI(configuredNft.token_id);
	const metadata = tokenURI ? await fetchNFTMetadata(tokenURI) : {};
	return {
		name: metadata.name || `NFT #${configuredNft.token_id}`,
		description: metadata.description,
		image: metadata.image,
		animation_url: metadata.animation_url,
		external_url: metadata.external_url,
		attributes: metadata.attributes
	};
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
async function loadErc1155Metadata(configuredNft: INftConf, provider: any, address: string): Promise<INftLoadedInfo | null> {
	// ERC1155 requires specific token ID - can't enumerate like ERC721
	if (!configuredNft.token_id) return null;
	
	const contract = new Contract(configuredNft.contract_address, erc1155ABI, provider);
	
	// Check balance for this specific token ID
	const balance = Number(await contract.balanceOf(address, configuredNft.token_id));
	if (balance === 0) return null;
	
	// User has this token - get its metadata URI
	const tokenURI = await contract.uri(configuredNft.token_id);
	const metadata = tokenURI ? await fetchNFTMetadata(tokenURI) : {};
	return {
		name: metadata.name || `Token #${configuredNft.token_id}`,
		description: metadata.description,
		image: metadata.image,
		animation_url: metadata.animation_url,
		external_url: metadata.external_url,
		attributes: metadata.attributes
	};
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
	try {
		// Try ERC721 first (most common NFT standard)
		const erc721Metadata = await loadErc721Metadata(configuredNft, provider, address);
		if (erc721Metadata) return erc721Metadata;
	} catch (erc721Error) {
		// ERC721 failed - contract might be ERC1155 or have different interface
		try {
			const erc1155Metadata = await loadErc1155Metadata(configuredNft, provider, address);
			if (erc1155Metadata) return erc1155Metadata;
		} catch (erc1155Error) {
			console.warn(`Contract ${configuredNft.contract_address} is neither ERC721 nor ERC1155 compatible`);
		}
	}
	
	return null;
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
	
	const tokensToLoad = nftItems.filter(nft => 
		!currentlyLoading.has(nft.guid) && !currentMetadata.has(nft.guid)
	);
	
	if (!tokensToLoad.length) return;
	
	console.log('Loading NFT token metadata for', tokensToLoad.length, 'tokens');

	// Mark these NFTs as currently loading to prevent duplicate requests
	loadingNftTokens.update(set => {
		tokensToLoad.forEach(nft => set.add(nft.guid));
		return set;
	});

	// Get provider and user address for blockchain calls
	const p = get(provider);
	const addr = get(selectedAddress);
	
	if (!p || !addr) {
		// Clean up loading state if we can't proceed
		loadingNftTokens.update(set => {
			tokensToLoad.forEach(nft => set.delete(nft.guid));
			return set;
		});
		console.warn('Provider or address not available for loading NFT metadata');
		return;
	}

	// Load metadata for all NFTs in parallel
	const results = await Promise.allSettled(
		tokensToLoad.map(async (configuredNft) => {
			const metadata = await loadSingleNftMetadata(configuredNft, p, addr.address);
			return metadata ? { guid: configuredNft.guid, metadata } : null;
		})
	);

	// Update the metadata store with successful results
	nftTokenMetadatas.update(map => {
		results.forEach((result) => {
			if (result.status === 'fulfilled' && result.value) {
				map.set(result.value.guid, result.value.metadata);
			}
		});
		return map;
	});

	// Clean up loading state
	loadingNftTokens.update(set => {
		tokensToLoad.forEach(nft => set.delete(nft.guid));
		return set;
	});
}

/**
 * Load NFT balances for multiple NFT configurations
 * @param nftItems - Array of configured NFTs to load balances for
 */
export async function loadNFTBalances(nftItems: INftConf[]): Promise<void> {
	if (!nftItems.length) return;

	console.log('Loading NFT balances for', nftItems.length, 'NFTs');

	// Load balances in parallel - refreshNftBalance handles deduplication
	await Promise.all(
		nftItems.map(nft => refreshNftBalance(nft.guid))
	);
}

/**
 * Load both collection info, token metadata, and balances
 */
export async function loadNFTsData(nftItems: INftConf[]): Promise<void> {
	if (!nftItems.length) return;
	
	//console.log('Loading complete NFT data for', nftItems.length, 'items');
	
	const contractAddresses = [...new Set(nftItems.map(nft => nft.contract_address))];
	
	await Promise.all([
		loadNFTCollectionInfos(contractAddresses),
		loadNFTTokenMetadata(nftItems),
		loadNFTBalances(nftItems)
	]);
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
			tokenURI = tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/');
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
			metadata.image = metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
			// Fix double ipfs/ in image URL too
			metadata.image = metadata.image.replace('ipfs/ipfs/', 'ipfs/');
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
		console.warn('Failed to fetch NFT metadata from:', tokenURI, error);
		return {};
	}
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
}

export const nftsForDisplay = derived(
	[nftConfs, nftCollectionInfos, nftTokenMetadatas, nftBalances, loadingNftCollections, loadingNftBalances],
	([$nftConfs, $nftCollectionInfos, $nftTokenMetadatas, $nftBalances, $loadingNftCollections, $loadingNftBalances]) => {
		return $nftConfs.map(conf => {

			const collectionInfo = $nftCollectionInfos.get(conf.contract_address);
			const tokenMetadata = $nftTokenMetadatas.get(conf.guid);
			const balance = $nftBalances.get(conf.guid);
			const isLoadingCollection = $loadingNftCollections.has(conf.contract_address);
			const isLoadingBalance = $loadingNftBalances.has(conf.guid);

			return {
				conf: conf,
				tokenMetadata,
				collectionInfo,
				balance,
				isLoadingCollection,
				isLoadingBalance,
				displayName: (tokenMetadata?.name || collectionInfo?.name || 'NFT') + (conf.token_id ? ` #${conf.token_id}` : ''),
			} as INftForDisplay;
		});
	}
);

// Clean up old NFT data that's no longer configured
function cleanupOldNftData(currentConfigs: INftConf[]) {
	const currentGuids = new Set(currentConfigs.map(conf => conf.guid));
	const currentContracts = new Set(currentConfigs.map(conf => conf.contract_address));
	
	// Clean up metadata and balances for removed NFTs
	nftTokenMetadatas.update(map => {
		const newMap = new Map();
		for (const [guid, data] of map.entries()) {
			if (currentGuids.has(guid)) {
				newMap.set(guid, data);
			}
		}
		return newMap;
	});
	
	nftBalances.update(map => {
		const newMap = new Map();
		for (const [guid, data] of map.entries()) {
			if (currentGuids.has(guid)) {
				newMap.set(guid, data);
			}
		}
		return newMap;
	});
	
	// Clean up collection info for unused contracts
	nftCollectionInfos.update(map => {
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
	cleanupOldNftData(configs);
	if (configs.length > 0) {
		await loadNFTsData(configs);
	}
});

/**
 * Refresh NFT balance for a specific NFT configuration
 * @param guid - The GUID of the NFT configuration to refresh
 */
export async function refreshNftBalance(guid: Guid): Promise<void> {
	// Skip if already loading
	const currentlyLoading = get(loadingNftBalances);
	if (currentlyLoading.has(guid)) {
		return;
	}

	const nftConfigurations = get(nftConfs);
	const configuredNft = nftConfigurations.find(nft => nft.guid === guid);
	
	if (!configuredNft) {
		console.warn(`NFT configuration not found for GUID: ${guid}`);
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
		set.add(guid);
		return set;
	});

	try {
		let amount = 0;

		if (configuredNft.token_id) {
			// Try ERC-721 first
			try {
				const contract = new Contract(configuredNft.contract_address, erc721ABI, p);
				const owner = await contract.ownerOf(configuredNft.token_id);
				amount = owner.toLowerCase() === addr.address.toLowerCase() ? 1 : 0;
			} catch {
				// Try ERC-1155
				try {
					const contract = new Contract(configuredNft.contract_address, erc1155ABI, p);
					const balance = await contract.balanceOf(addr.address, configuredNft.token_id);
					amount = Number(balance);
				} catch (error) {
					console.warn(`Failed to get balance for NFT ${guid}:`, error);
				}
			}
		}

		// Update balance store
		nftBalances.update(map => {
			const newMap = new Map(map);
			newMap.set(guid, {
				amount,
				timestamp: new Date()
			});
			return newMap;
		});

	} finally {
		// Clean up loading state
		loadingNftBalances.update(set => {
			set.delete(guid);
			return set;
		});
	}
}

