import { Client, HttpClient } from '@chainify/client';
import { EvmChainProvider } from '@chainify/evm';
import LiFi from '@lifi/sdk';
import { ChainId, chains, currencyToUnit } from '@liquality/cryptoassets';
import BN, { BigNumber } from 'bignumber.js';
import { v4 as uuidv4 } from 'uuid';
import { ActionContext } from '../../store';
import { withInterval, withLock } from '../../store/actions/performNextAction/utils';
import { Network } from '../../store/types';
import { prettyBalance } from '../../utils/coinFormatter';
import cryptoassets from '../../utils/cryptoassets';
import { ChainNetworks } from '../../utils/networks';
import { EvmSwapHistoryItem } from '../EvmSwapProvider';
import { SwapProvider } from '../SwapProvider';
import {
  BaseSwapProviderConfig,
  EstimateFeeRequest,
  NextSwapActionRequest,
  QuoteRequest,
  SwapRequest,
  SwapStatus,
} from '../types';

const NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

interface LifiSwapHistoryItem extends EvmSwapHistoryItem {}

export interface LifiSwapProviderConfig extends BaseSwapProviderConfig {
  agent: string;
  routerAddress: string;
  referrerAddress: { [key in ChainId]?: string };
  referrerFee: number;
}

class LifiSwapProvider extends SwapProvider {
  public config: LifiSwapProviderConfig;
  private _httpClient: HttpClient;
  private _lifi: LiFi;

  constructor(config: LifiSwapProviderConfig) {
    super(config);
    this._httpClient = new HttpClient({ baseURL: 'https://li.quest/v1' });
    this._lifi = new LiFi({});
  }

  async getSupportedPairs() {
    return [];
  }

  public getClient(network: Network, walletId: string, asset: string, accountId: string) {
    return super.getClient(network, walletId, asset, accountId) as Client<EvmChainProvider>;
  }

  async _getQuote(fromChain: string, toChain: string, fromToken: string, toToken: string, fromAmount: BigNumber) {
    // Need to figure out how to get fromWallet ID here
    const fromWallet = '';
    const result = await this._httpClient.nodeGet('/quote', {
      params: {
        fromChain,
        toChain,
        fromToken,
        toToken,
        fromAmount,
        fromAddress: fromWallet,
      },
    });
    return result.data;
  }

  async getQuote({ from, to, amount, network }: QuoteRequest) {
    const chainIdFrom = ChainNetworks[cryptoassets[from].chain][network].chainId;
    const chainIdTo = ChainNetworks[cryptoassets[to].chain][network].chainId;

    const trade = await this._getQuote(chainIdFrom, chainIdTo, from, to, amount);

    const fromAmountInUnit = currencyToUnit(cryptoassets[from], amount);
    const toAmountInUnit = currencyToUnit(cryptoassets[from], trade?.estimate.toAmount);
    return {
      ...trade,
      from,
      to,
      fromAmount: fromAmountInUnit.toFixed(),
      toAmount: toAmountInUnit.toFixed(),
    };
  }

  async sendSwap({ network, walletId, quote }: SwapRequest<LifiSwapHistoryItem>) {
    const chainIdFrom = ChainNetworks[cryptoassets[quote.from].chain][network].chainId;
    const chainIdTo = ChainNetworks[cryptoassets[quote.to].chain][network].chainId;
    const fromAddressRaw = await this.getSwapAddress(network, walletId, quote.from, quote.fromAccountId);
    const fromAddress = chains[cryptoassets[quote.to].chain].formatAddress(fromAddressRaw);
    const client = this.getClient(network, walletId, quote.from, quote.fromAccountId);

    const result = await this._lifi.getRoutes({
      fromChainId: chainIdFrom,
      fromAmount: quote.fromAmount,
      fromTokenAddress: cryptoassets[quote.from].contractAddress || NATIVE_ASSET_ADDRESS,
      fromAddress: fromAddress,
      toChainId: chainIdTo,
      toTokenAddress: cryptoassets[quote.to].contractAddress || NATIVE_ASSET_ADDRESS,
    });

    const selectRoute = result.routes[0];

    const route = await this._lifi.executeRoute(client, selectRoute);

    return {
      ...quote,
      status: 'WAITING_FOR_SWAP_CONFIRMATIONS',
      route: route,
    };
  }

  async newSwap({ network, walletId, quote }: SwapRequest<LifiSwapHistoryItem>) {
    const updates = await this.sendSwap({ network, walletId, quote });

    return {
      ...updates,
      id: uuidv4(),
      fee: quote.fee,
    };
  }

  async estimateFees({ txType, quote, feePrices }: EstimateFeeRequest) {
    // define

    return null;
  }

  async getMin(_quoteRequest: QuoteRequest) {
    return new BN(0);
  }

  async waitForApproveConfirmations({ swap, network, walletId }: NextSwapActionRequest<LifiSwapHistoryItem>) {
    const client = this.getClient(network, walletId, swap.from, swap.fromAccountId);
    try {
      const tx = await client.chain.getTransactionByHash(swap.approveTxHash);
      if (tx && tx.confirmations && tx.confirmations >= 1) {
        return {
          endTime: Date.now(),
          status: 'APPROVE_CONFIRMED',
        };
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e);
      else throw e;
    }
  }

  async waitForSwapConfirmations({ swap, network, walletId }: NextSwapActionRequest<LifiSwapHistoryItem>) {
    try {
      // need to extract "bridge" here from the steps of the route.
      const bridge = '';
      const result = await this._httpClient.nodeGet('/status', {
        bridge: bridge,
        fromChain: swap.chainIdFrom,
        toChain: swap.chainIdFrom,
        txHash: swap.approveTxHash,
      });

      if (result.status === 'DONE' || result.status === 'FAILED') {
        this.updateBalances(network, walletId, [swap.toAccountId]);
        return {
          endTime: Date.now(),
          status: result.status === 'DONE' ? 'SUCCESS' : 'FAILED',
        };
      }
    } catch (err) {
      console.error('Network API error: ', err);
    }
  }

  async performNextSwapAction(
    store: ActionContext,
    { network, walletId, swap }: NextSwapActionRequest<LifiSwapHistoryItem>
  ) {
    switch (swap.status) {
      case 'WAITING_FOR_APPROVE_CONFIRMATIONS':
        return withInterval(async () => this.waitForApproveConfirmations({ swap, network, walletId }));
      case 'APPROVE_CONFIRMED':
        return withLock(store, { item: swap, network, walletId, asset: swap.from }, async () =>
          this.sendSwap({ quote: swap, network, walletId })
        );
      case 'WAITING_FOR_SWAP_CONFIRMATIONS':
        return withInterval(async () => this.waitForSwapConfirmations({ swap, network, walletId }));
    }
  }

  protected _getStatuses(): Record<string, SwapStatus> {
    return {
      WAITING_FOR_APPROVE_CONFIRMATIONS: {
        step: 1,
        label: 'Swapping {from}',
        filterStatus: 'PENDING',
        notification() {
          return {
            message: 'Engaging LiFi',
          };
        },
      },
      APPROVE_CONFIRMED: {
        step: 2,
        label: 'Swapping {to}',
        filterStatus: 'PENDING',
        notification() {
          return {
            message: 'Engaging LiFi',
          };
        },
      },
      SUCCESS: {
        step: 3,
        label: 'Completed',
        filterStatus: 'COMPLETED',
        notification(swap: any) {
          return {
            message: `Swap completed, ${prettyBalance(swap.toAmount, swap.to)} ${swap.to} ready to use`,
          };
        },
      },
      FAILED: {
        step: 3,
        label: 'Swap Failed',
        filterStatus: 'REFUNDED',
        notification() {
          return {
            message: 'Swap failed',
          };
        },
      },
    };
  }

  protected _txTypes() {
    return {
      SWAP: 'SWAP',
    };
  }

  protected _fromTxType(): string | null {
    return this._txTypes().SWAP;
  }

  protected _toTxType(): string | null {
    return null;
  }

  protected _timelineDiagramSteps(): string[] {
    return ['APPROVE', 'SWAP'];
  }

  protected _totalSteps(): number {
    return 3;
  }
}

export { LifiSwapProvider };
