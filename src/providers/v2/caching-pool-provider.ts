import { ChainId, Token } from '@juiceswapxyz/sdk-core';
import { Pair } from '@juiceswapxyz/v2-sdk';
import _ from 'lodash';

import { log } from '../../util/log';

import { ICache } from './../cache';
import { ProviderConfig } from './../provider';
import { IV2PoolProvider, V2PoolAccessor, V2TokenPair } from './pool-provider';

/**
 * Provider for getting V2 pools, with functionality for caching the results per block.
 *
 * @export
 * @class CachingV2PoolProvider
 */
export class CachingV2PoolProvider implements IV2PoolProvider {
  private POOL_KEY = (chainId: ChainId, address: string) =>
    `pool-${chainId}-${address}`;

  /**
   * Creates an instance of CachingV3PoolProvider.
   * @param chainId The chain id to use.
   * @param poolProvider The provider to use to get the pools when not in the cache.
   * @param cache Cache instance to hold cached pools.
   */
  constructor(
    protected chainId: ChainId,
    protected poolProvider: IV2PoolProvider,
    // Cache is block aware. For V2 pools we need to use the current blocks reserves values since
    // we compute quotes off-chain.
    // If no block is specified in the call to getPools we just return whatever is in the cache.
    private cache: ICache<{ pair: Pair; block?: number }>
  ) { }

  public async getPools(
    tokenPairs: V2TokenPair[],
    providerConfig?: ProviderConfig
  ): Promise<V2PoolAccessor> {
    const poolAddressSet: Set<string> = new Set<string>();
    const poolsToGetTokenPairs: V2TokenPair[] = [];
    const poolsToGetAddresses: string[] = [];
    const poolAddressToPool: { [poolAddress: string]: Pair } = {};

    const blockNumber = await providerConfig?.blockNumber;

    for (const tokenPair of tokenPairs) {
      let tokenA: Token;
      let tokenB: Token;
      let providedPoolAddress: string | undefined;

      // Handle both tuple and object formats
      if (Array.isArray(tokenPair)) {
        [tokenA, tokenB] = tokenPair;
      } else {
        tokenA = tokenPair.tokenA;
        tokenB = tokenPair.tokenB;
        providedPoolAddress = tokenPair.poolAddress;
      }

      const { token0, token1 } = this.getPoolAddress(tokenA, tokenB);

      // Use provided address or compute it
      const poolAddress = providedPoolAddress ?? this.getPoolAddress(tokenA, tokenB).poolAddress;

      if (poolAddressSet.has(poolAddress)) {
        continue;
      }

      poolAddressSet.add(poolAddress);

      const cachedPool = await this.cache.get(
        this.POOL_KEY(this.chainId, poolAddress)
      );

      if (cachedPool) {
        // If a block was specified by the caller, ensure that the result in our cache matches the
        // expected block number. If a block number is not specified, just return whatever is in the
        // cache.
        if (!blockNumber || (blockNumber && cachedPool.block == blockNumber)) {
          poolAddressToPool[poolAddress] = cachedPool.pair;
          continue;
        }
      }

      // Pass through the original format (with pool address if provided)
      if (providedPoolAddress) {
        poolsToGetTokenPairs.push({ tokenA: token0, tokenB: token1, poolAddress: providedPoolAddress });
      } else {
        poolsToGetTokenPairs.push([token0, token1]);
      }
      poolsToGetAddresses.push(poolAddress);
    }

    log.info(
      {
        poolsFound: _.map(
          Object.values(poolAddressToPool),
          (p) => p.token0.symbol + ' ' + p.token1.symbol
        ),
        poolsToGetTokenPairs: _.map(
          poolsToGetTokenPairs,
          (t) => {
            if (Array.isArray(t)) {
              return t[0].symbol + ' ' + t[1].symbol;
            }
            return t.tokenA.symbol + ' ' + t.tokenB.symbol;
          }
        ),
      },
      `Found ${Object.keys(poolAddressToPool).length
      } V2 pools already in local cache for block ${blockNumber}. About to get reserves for ${poolsToGetTokenPairs.length
      } pools.`
    );

    if (poolsToGetAddresses.length > 0) {
      const poolAccessor = await this.poolProvider.getPools(
        poolsToGetTokenPairs,
        {
          ...providerConfig,
          enableFeeOnTransferFeeFetching: true,
        }
      );
      for (const address of poolsToGetAddresses) {
        const pool = poolAccessor.getPoolByAddress(address);
        if (pool) {
          poolAddressToPool[address] = pool;
          // We don't want to wait for this caching to complete before returning the pools.
          this.cache.set(this.POOL_KEY(this.chainId, address), {
            pair: pool,
            block: blockNumber,
          });
        }
      }
    }

    return {
      getPool: (tokenA: Token, tokenB: Token): Pair | undefined => {
        const { poolAddress } = this.getPoolAddress(tokenA, tokenB);
        return poolAddressToPool[poolAddress];
      },
      getPoolByAddress: (address: string): Pair | undefined =>
        poolAddressToPool[address],
      getAllPools: (): Pair[] => Object.values(poolAddressToPool),
    };
  }

  public getPoolAddress(
    tokenA: Token,
    tokenB: Token
  ): { poolAddress: string; token0: Token; token1: Token } {
    return this.poolProvider.getPoolAddress(tokenA, tokenB);
  }
}
