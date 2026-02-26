import { AbstractPaymentProvider, BigNumber, MedusaError, ModuleProvider, Modules } from '@medusajs/framework/utils';
import { Logger } from '@medusajs/medusa';
import { AuthorizePaymentInput, AuthorizePaymentOutput, CancelPaymentInput, CancelPaymentOutput, CapturePaymentInput, CapturePaymentOutput, DeletePaymentInput, DeletePaymentOutput, GetPaymentStatusInput, GetPaymentStatusOutput, InitiatePaymentInput, InitiatePaymentOutput, ProviderWebhookPayload, RefundPaymentInput, RefundPaymentOutput, RetrievePaymentInput, RetrievePaymentOutput, UpdatePaymentInput, UpdatePaymentOutput, WebhookActionResult } from '@medusajs/types';
import TPaySDK, { TPay } from '@tax1driver/node-tpay';
import { z } from 'zod';

export const TPayOptionsSchema = z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    sandbox: z.boolean().optional().default(true),
    returnUrl: z.string().url(),
    failureUrl: z.string().url().optional(),
    callbackUrl: z.string().url(),
    title: z.string().optional(),
    refundDescription: z.string().optional(),
}).superRefine((data, ctx) => {
    if (!data.failureUrl) {
        data.failureUrl = data.returnUrl;
    }
});


export type TPayOptions = z.infer<typeof TPayOptionsSchema>;

export const InitiatePaymentSchema = z.object({
    session_id: z.string(),
    customer_name: z.string(),
    email: z.string().email(),
});

const SupportedCurrencies = ['PLN'];

interface TPayPaymentData {
    session_id: string;
    amount: number;
    currency: string;
    tx_id: string;
    url: string;
}

type InjectedDeps = {
    logger: Logger;
}

export class TPayPaymentProviderService extends AbstractPaymentProvider<TPayOptions> {
    static identifier = 'tpay';

    protected logger_: Logger;
    protected options_: TPayOptions;
    protected client_: TPaySDK;

    constructor(container: InjectedDeps, options: TPayOptions) {
        super(container);

        this.logger_ = container.logger;
        this.options_ = TPayOptionsSchema.parse(options);

        this.client_ = new TPaySDK({
            clientId: this.options_.clientId,
            clientSecret: this.options_.clientSecret,
            sandbox: this.options_.sandbox,
        });
    }

    static validateOptions(options: Record<any, any>): void | never {
        TPayOptionsSchema.parse(options);
    }

    async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
        const data = InitiatePaymentSchema.parse(input.data);
        const sessionId = data.session_id;

        if (!SupportedCurrencies.includes(input.currency_code.toUpperCase())) {
            throw new MedusaError(
                MedusaError.Types.NOT_ALLOWED,
                `Currency ${input.currency_code} is not supported by TPay payment provider. Supported currencies are: ${SupportedCurrencies.join(', ')}`
            );
        }

        const transaction = await this.client_.transactions.createTransaction({
            amount: Math.ceil(Number(input.amount) * 100) / 100,
            currency: input.currency_code.toUpperCase() as any,
            description: this.options_.title || `Payment ${sessionId}`,
            payer: { email: data.email, name: data.customer_name },
            hiddenDescription: sessionId,
            callbacks: {
                notification: { url: this.options_.callbackUrl },
                payerUrls: { success: this.options_.returnUrl, error: this.options_.failureUrl }
            }
        } as any);

        const paymentData: TPayPaymentData = {
            session_id: sessionId,
            amount: Number(input.amount),
            currency: input.currency_code,
            tx_id: transaction.title,
            url: transaction.transactionPaymentUrl,
        };

        if (transaction.status === "paid") {
            return {
                id: transaction.title,
                data: { ...paymentData },
                status: 'authorized',
            }
        } else if (transaction.status === "canceled") {
            return {
                id: transaction.title,
                data: { ...paymentData },
                status: 'canceled',
            }
        } else {
            return {
                id: transaction.title,
                data: { ...paymentData },
                status: 'pending',
            }
        }
    }

    async getWebhookActionAndData(payload: ProviderWebhookPayload['payload']): Promise<WebhookActionResult> {
        const { data, rawData, headers } = payload;

        const tpayResult = await this.client_.notifications.validateRequest(
            headers as Record<string, string>,
            JSON.stringify(data)
        );

        if (!tpayResult.valid) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Invalid TPay webhook payload received. ${tpayResult.error}`
            );
        }

        const sessionId = tpayResult.data.tr_crc;
        let action: WebhookActionResult['action'] = "pending";

        if (tpayResult.data.tr_status === "TRUE") {
            action = "authorized"
        } else if (tpayResult.data.tr_status === "FALSE") {
            action = "canceled"
        } else {
            action = "pending"
        }

        return {
            action,
            data: {
                session_id: sessionId,
                amount: new BigNumber(tpayResult.data.tr_amount),
            }
        }
    }

    async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
        try {
            const result = await this.getPaymentStatus(input);

            return {
                data: input.data,
                status: result.status
            }
        } catch (e) {
            throw e;
        }
    }

    async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
        const data = input.data as unknown as TPayPaymentData;

        if (!data || !data.session_id) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Missing or invalid payment data for TPay payment capture.`
            );
        }

        const transaction = await this.client_.transactions.getTransaction(data.tx_id);
        if (transaction.status === "correct") {
            return {
                data: { ...input.data }
            };
        }

        throw new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            `Cannot capture payment for transaction with status ${transaction.status}.`
        );
    }

    async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
        const data = input.data as unknown as TPayPaymentData;

        if (!data || !data.session_id) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Missing or invalid payment data for TPay payment refund.`
            );
        }

        const refund = await this.client_.transactions.createRefund(data.tx_id, {
            amount: Number(input.amount)
        });

        if (refund.result !== "success") {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `Refund request was not successful.`
            );
        }

        return {
            data: { ...input.data }
        }
    }

    async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
        const data = input.data as unknown as TPayPaymentData;

        if (!data || !data.session_id) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Missing or invalid payment data for TPay payment status check.`
            );
        }

        try {
            const transaction = await this.client_.transactions.getTransaction(data.tx_id);

            if (transaction.status === "correct") {
                return { status: 'authorized' };
            } else if (transaction.status === "canceled") {
                return { status: "canceled" };
            } else {
                return { status: 'pending' };
            }
        } catch (e) {
            throw new MedusaError(
                MedusaError.Types.NOT_FOUND,
                `TPay transaction with ID ${data.tx_id} not found.`
            );
        }


    }

    async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
        return { data: input.data };
    }

    async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
        const data = input.data as unknown as TPayPaymentData;

        if (!data || !data.session_id) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Missing or invalid payment data for TPay payment cancellation.`
            );
        }

        const transaction = await this.client_.transactions.getTransaction(data.tx_id);

        if (transaction.status === "canceled") {
            return { data: { ...input.data } };
        }

        const cancelResult = await this.client_.transactions.cancelTransaction(data.tx_id);

        if (cancelResult.result !== "success") {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `Cancellation request was not successful.`
            );
        }

        return { data: { ...input.data } };
    }

    async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
        return { data: input.data };
    }

    async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
        throw new MedusaError(
            MedusaError.Types.INVALID_ARGUMENT,
            "Updating tpay payments is not supported."
        );
    }

    getIdentifier(): string {
        return TPayPaymentProviderService.identifier;
    }
}

export default ModuleProvider(Modules.PAYMENT, {
    services: [TPayPaymentProviderService],
});