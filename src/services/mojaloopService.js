import axios from 'axios'

const MOJALOOP_SDK_URL = process.env.MOJALOOP_SDK_URL || 'http://127.0.0.1:5001'

/**
 * Serviço de integração com o Mojaloop SDK.
 * Implementa o protocolo de 3 passos: Initiate → Party → Quote.
 */
class MojaloopService {
  /**
   * PASSO 1: Inicia a transferência e faz o lookup do destinatário (Party Lookup).
   * POST {mojaloop_sdk}/transfers
   * @returns {{ mojaloopTransferId, partyInfo }}
   */
  async initiateTransfer({ amount, currency, debtorAccount, creditorAccount, creditorName }) {
    console.log(`[Mojaloop] Initiating transfer → ${creditorAccount} (${creditorName}) amount: ${amount} ${currency}`)

    const payload = {
      homeTransactionId: `HUB-${Date.now()}`,
      from: {
        idType: 'ACCOUNT_ID',
        idValue: debtorAccount
      },
      to: {
        idType: 'ACCOUNT_ID',
        idValue: creditorAccount
      },
      amountType: 'SEND',
      currency,
      amount: String(amount),
      transactionType: 'TRANSFER'
    }

    const { data } = await axios.post(`${MOJALOOP_SDK_URL}/transfers`, payload)

    console.log(`[Mojaloop] Transfer initiated. ID: ${data.transferId}, Party: ${data.to?.displayName}`)

    return {
      mojaloopTransferId: data.transferId,
      partyInfo: {
        name: data.to?.displayName || creditorName,
        account: creditorAccount,
        fspId: data.to?.fspId || null
      }
    }
  }

  /**
   * PASSO 2: Confirma o destinatário e recebe a cotação (Quote).
   * PUT {mojaloop_sdk}/transfers/{id} { acceptParty: true }
   * GET {mojaloop_sdk}/transfers/{id}
   * @returns {{ quoteInfo }}
   */
  async confirmParty(mojaloopTransferId) {
    console.log(`[Mojaloop] Confirming party for transfer: ${mojaloopTransferId}`)

    await axios.put(`${MOJALOOP_SDK_URL}/transfers/${mojaloopTransferId}`, {
      acceptParty: true
    })

    // Aguarda processamento
    await new Promise(r => setTimeout(r, 500))

    const { data } = await axios.get(`${MOJALOOP_SDK_URL}/transfers/${mojaloopTransferId}`)

    console.log(`[Mojaloop] Quote received. Fee: ${data.quoteResponse?.transferAmount?.amount}`)

    return {
      quoteInfo: {
        transferAmount: data.quoteResponse?.transferAmount || null,
        payeeFspFee: data.quoteResponse?.payeeFspFee || null,
        expiration: data.quoteResponse?.expiration || null,
        ilpPacket: data.quoteResponse?.ilpPacket || null,
        condition: data.quoteResponse?.condition || null
      }
    }
  }

  /**
   * PASSO 3: Confirma a cotação e executa a transferência final.
   * PUT {mojaloop_sdk}/transfers/{id} { acceptQuote: true }
   * @returns {{ status: 'COMPLETED' | 'FAILED' }}
   */
  async confirmQuote(mojaloopTransferId) {
    console.log(`[Mojaloop] Executing transfer: ${mojaloopTransferId}`)

    const { data } = await axios.put(`${MOJALOOP_SDK_URL}/transfers/${mojaloopTransferId}`, {
      acceptQuote: true
    })

    const status = data.currentState === 'COMPLETED' ? 'COMPLETED' : 'FAILED'
    console.log(`[Mojaloop] Transfer ${mojaloopTransferId} → ${status}`)

    return { status }
  }
}

export default new MojaloopService()
