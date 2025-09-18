
/* top-level module to manage loading and refreshing of all info and balance data

native currency balance:
- balance, isLoadingBalance, refreshBalance(user click)

token infos and balances:
- tokenInfos, isLoadingTokenInfos, tokenBalances, isLoadingTokenBalances, refreshTokenBalance(user click)

nfts:
- nftDisplayData, refreshNftBalance

* */





export function reset() {
		// Placeholder function to reset all info and balance data, such as when switching wallets

}


export function setRefreshEnabled(enabled: boolean) {
		// Placeholder function to set refresh enabled/disabled
		if (enabled) {
			// set up intervals
		}
		else {
			// clear intervals
		}


}


export function refresh() {
	// Placeholder function to refresh all info and balance data
	// token infos arent refreshed unless token config changes
	// balances are refreshed always

	// use explicit refresh promise, dont overlap refreshes
	//

}


let refreshPromise: Promise<void> | null = null;

