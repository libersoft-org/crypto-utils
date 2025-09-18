import { formatUnits, Contract } from 'ethers';
import { get, writable } from 'svelte/store';
import { getNFTsFromConfiguredContracts } from './balance.ts';
import { guid, INFT, INFTItemDisplayData } from './types.ts';
import { provider } from './provider.ts';
import { nfts as nftStore, selectedNetwork } from './network.ts';
import { selectedAddress } from './wallet.ts';



export let nftDisplayData = writable<Map<guid,INFTItemDisplayData>>(new Map());



// ERC-721 and ERC-1155 ABIs for NFT operations
const erc721ABI = ['function balanceOf(address owner) view returns (uint256)', 'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)', 'function tokenURI(uint256 tokenId) view returns (string)', 'function ownerOf(uint256 tokenId) view returns (address)', 'function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function tokenByIndex(uint256 index) view returns (uint256)'];
// Alternative minimal ABI for contracts that might not support full enumeration
const erc721MinimalABI = ['function balanceOf(address owner) view returns (uint256)', 'function ownerOf(uint256 tokenId) view returns (address)', 'function tokenURI(uint256 tokenId) view returns (string)', 'function name() view returns (string)', 'function symbol() view returns (string)'];
const erc1155ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)', 'function uri(uint256 id) view returns (string)'];




export async function loadNFTsData(nfts_items: INFT[]) {

	// Load info for all configured NFT contracts
	if (!nfts_items || nfts_items.length === 0) return;
	console.log('Loading NFT contract infos for', nfts_items.length, 'contracts');


	const new_nft_data = new Map<string, any>();

	nfts_items.forEach(nft => {
		if (!nft.contract_address) return;
		new_nft_data[nft.guid] = { loading: true };
	});


	try {

		const allNFTItems = await getNFTsFromConfiguredContracts();

		console.log('Loaded all NFT items:', allNFTItems.length);
		console.log('Processing NFT contracts, nfts_items:', nfts_items);
		console.log('About to process', nfts_items.length, 'configured contracts');

	} catch (error) {

	}
}


async function processNFTToken(contract: Contract, contractAddress: string, tokenId: string, balance?: number): Promise<INFTItem | null> {
	try {
		console.log(`    🎨 Processing NFT ${contractAddress} #${tokenId}`);

		// Get collection info (name and symbol)
		let collectionName = '';
		let collectionSymbol = '';
		try {
			collectionName = await contract.name();
			console.log(`    📋 Collection name: ${collectionName}`);
		} catch (error) {
			console.warn(`    ⚠️ Failed to get collection name:`, error instanceof Error ? error.message : error);
		}

		try {
			collectionSymbol = await contract.symbol();
			console.log(`    📋 Collection symbol: ${collectionSymbol}`);
		} catch (error) {
			console.warn(`    ⚠️ Failed to get collection symbol:`, error instanceof Error ? error.message : error);
		}

		// Get token URI for metadata
		let tokenURI = '';
		try {
			tokenURI = await contract.tokenURI(tokenId);
			console.log(`    🔗 Token URI for ${contractAddress} #${tokenId}:`, tokenURI);
		} catch (error) {
			console.warn(`    ❌ Failed to get tokenURI for ${contractAddress} #${tokenId}:`, error instanceof Error ? error.message : error);
		}

		// Fetch metadata
		const metadata = tokenURI ? await fetchNFTMetadata(tokenURI) : {};

		const nftItem: INFTItem = {
			contract_address: contractAddress,
			token_id: tokenId,
			name: metadata.name || `NFT #${tokenId}`,
			description: metadata.description,
			image: metadata.image,
			animation_url: metadata.animation_url,
			external_url: metadata.external_url,
			attributes: metadata.attributes,
			collection_name: collectionName,
			collection_symbol: collectionSymbol,
			balance: balance
		};

		console.log(`    ✅ Added NFT: ${metadata.name || `NFT #${tokenId}`} from collection: ${collectionName}`);
		return nftItem;
	} catch (error) {
		console.warn(`    ❌ Error processing NFT ${contractAddress} #${tokenId}:`, error instanceof Error ? error.message : error);
		return null;
	}
}


// Load NFTs from configured contracts only
export async function getNFTsFromConfiguredContracts(): Promise<INFTItem[]> {

	const p = get(provider);
	const net = get(selectedNetwork);
	const addr = get(selectedAddress);
	const configuredNFTs = get(nftStore) || [];

	if (!net || !p || !addr) {
		console.error('Network, provider, or address not set');
		return [];
	}

	if (configuredNFTs.length === 0) {
		console.log('No NFT contracts configured');
		return [];
	}

	console.log(`Loading NFTs from ${configuredNFTs.length} configured contracts for address:`, addr.address);

	const allNFTs: INFTItem[] = [];

	for (const configuredNFT of configuredNFTs) {
		if (!configuredNFT.contract_address) continue;

		try {
			console.log(`checking nft contract: ${configuredNFT.contract_address}`);

			try {
				await loadErc721Info(configuredNFT.contract_address);

			} catch (erc721Error) {

				console.log(`Contract ${configuredNFT.contract_address} is not ERC721, trying ERC1155...`);
				await loadErc1155Info(configuredNFT.contract_address);

			}
		} catch (error) {
			console.error(`Error processing NFT contract ${configuredNFT.contract_address}:`, error);
		}
	}

	console.log(`Found ${allNFTs.length} NFTs from configured contracts`);
	return allNFTs;
}


async function loadErc721Info(contract_address: string) {
	const contract = new Contract(contract_address, erc721ABI, p);
	const balance = Number(await contract.balanceOf(addr.address));
	console.log(`ERC721 balance for contract ${configuredNFT.contract_address}: ${balance}`);

	if (balance > 0) {
		// Try to get token IDs using tokenOfOwnerByIndex if available
		try {
			for (let i = 0; i < Math.min(balance, 10); i++) {
				// Limit to first 10 NFTs
				const tokenId = await contract.tokenOfOwnerByIndex(addr.address, i);
				const nftItem = await processNFTToken(contract, configuredNFT.contract_address, tokenId.toString(), 1);
				if (nftItem) {
					allNFTs.push(nftItem);
				}
			}
		} catch (error) {
			console.warn(`Contract ${configuredNFT.contract_address} doesn't support tokenOfOwnerByIndex`);
			// Create a placeholder NFT item showing we have NFTs but can't enumerate them
			const basicNFT: INFTItem = {
				contract_address: configuredNFT.contract_address,
				token_id: '0',
				name: `${balance} NFTs owned`,
				description: 'Contract does not support token enumeration',
				collection_name: 'Unknown Collection',
				collection_symbol: 'UNK',
				balance: balance
			};
			allNFTs.push(basicNFT);
		}
	}
}


async function loadErc1155Info(contract_address: string) {

	// Try ERC1155 - but we need specific token IDs to check
	try {
		const erc1155Contract = new Contract(configuredNFT.contract_address, erc1155ABI, p);

		// If user configured specific token_id, check that
		if (configuredNFT.token_id) {
			const balance = Number(await erc1155Contract.balanceOf(addr.address, configuredNFT.token_id));
			console.log(`ERC1155 balance for token ${configuredNFT.token_id}: ${balance}`);

			if (balance > 0) {
				// Get basic contract info
				let collectionName = 'Unknown Collection';
				let collectionSymbol = 'UNK';
				try {
					const contract = new Contract(configuredNFT.contract_address, erc721ABI, p);
					collectionName = await contract.name();
					collectionSymbol = await contract.symbol();
				} catch (nameError) {
					console.warn(`Could not get collection info:`, nameError);
				}

				// Get token URI if available
				let tokenURI = '';
				let metadata: any = {};
				try {
					tokenURI = await erc1155Contract.uri(configuredNFT.token_id);
					console.log(`Token URI for ERC1155 token ${configuredNFT.token_id}:`, tokenURI);
					if (tokenURI) {
						metadata = await fetchNFTMetadata(tokenURI);
					}
				} catch (uriError) {
					console.warn(`Could not get token URI:`, uriError);
				}

				const nftItem: INFTItem = {
					contract_address: configuredNFT.contract_address,
					token_id: configuredNFT.token_id,
					name: metadata.name || `Token #${configuredNFT.token_id}`,
					description: metadata.description,
					image: metadata.image,
					animation_url: metadata.animation_url,
					external_url: metadata.external_url,
					attributes: metadata.attributes,
					collection_name: collectionName,
					collection_symbol: collectionSymbol,
					balance: balance
				};
				allNFTs.push(nftItem);
			}
		} else {
			console.warn(`ERC1155 contract ${configuredNFT.contract_address} requires specific token_id to check balance`);
		}
	} catch (erc1155Error) {
		console.warn(`Contract ${configuredNFT.contract_address} is neither ERC721 nor ERC1155 compatible`);
	}


}


async function fetchNFTMetadata(tokenURI: string): Promise<Partial<INFTItem>> {
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

