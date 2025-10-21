import { derived } from 'svelte/store';
import type { ICurrency } from './types';
import { selectedNetwork } from './network';
import { tokenConfs, tokenInfos } from './tokens';
import { nftsForDisplay } from './nfts';

/**
 * Store for available currencies (native + tokens + NFTs) for the selected network
 * Combines native currency with configured tokens and NFTs that have balances
 */
export const currencies = derived([selectedNetwork, tokenConfs, tokenInfos, nftsForDisplay], ([$selectedNetwork, $tokenConfs, $tokenInfos, $nftsForDisplay]) => {
	const currencyList: ICurrency[] = [];
	
	// Add native currency
	if ($selectedNetwork?.currency?.symbol) {
		currencyList.push({
			type: 'native',
			symbol: $selectedNetwork.currency.symbol,
			iconURL: $selectedNetwork.currency.iconURL,
		});
	}
	
	// Add tokens
	$tokenConfs?.forEach(token => {
		if (token.contract_address) {
			const tokenInfo = $tokenInfos.get(token.contract_address);
			const symbol = tokenInfo?.symbol || token.contract_address.slice(0, 8) + '...';
			currencyList.push({
				type: 'token',
				symbol: symbol,
				iconURL: token.iconURL,
				contract_address: token.contract_address,
				decimals: tokenInfo?.decimals ?? 18,
			});
		}
	});

	// Add NFTs (only those with balance > 0)
	$nftsForDisplay?.forEach(nft => {
		if (nft.balance?.amount && nft.balance.amount > 0) {
			const standard: 'ERC721' | 'ERC1155' = (nft.standard === 'ERC721' || nft.standard === 'ERC1155') ? nft.standard : 'ERC721';
			currencyList.push({
				type: 'nft',
				symbol: nft.displayName,
				iconURL: nft.tokenMetadata?.image,
				contract_address: nft.conf.contract_address,
				tokenId: nft.conf.token_id || '0',
				standard: standard,
				metadata: nft.tokenMetadata,
			});
		}
	});

	return currencyList;
});