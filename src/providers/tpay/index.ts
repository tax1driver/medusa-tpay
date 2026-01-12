import { AbstractPaymentProvider, MedusaError } from '@medusajs/framework/utils';
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

    constructor(options: TPayOptions, container: InjectedDeps) {
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
        this.logger_.info(`initiatePayment: ${JSON.stringify(input)}`);
        const data = InitiatePaymentSchema.parse(input.data);
        const sessionId = data.session_id;

        if (!SupportedCurrencies.includes(input.currency_code)) {
            throw new MedusaError(
                MedusaError.Types.NOT_ALLOWED,
                `Currency ${input.currency_code} is not supported by TPay payment provider. Supported currencies are: ${SupportedCurrencies.join(', ')}`
            );
        }

        const transaction = await this.client_.transactions.createTransaction({
            amount: Number(input.amount),
            currency: input.currency_code as any,
            description: this.options_.title || `Payment ${sessionId}`,
            payer: { email: data.email, name: data.customer_name },
            pay: { method: "pay_by_link", groupId: null, channelId: null },
            hiddenDescription: sessionId,
            callbacks: {
                notification: { url: this.options_.callbackUrl },
                payerUrls: { success: this.options_.returnUrl, error: this.options_.failureUrl }
            }
        });

        const paymentData: TPayPaymentData = {
            session_id: sessionId,
            amount: Number(input.amount),
            currency: input.currency_code,
            tx_id: transaction.transactionId,
            url: transaction.transactionPaymentUrl,
        };

        if (transaction.status === "paid") {
            return {
                id: transaction.transactionId,
                data: { ...paymentData },
                status: 'authorized',
            }
        } else if (transaction.status === "canceled") {
            return {
                id: transaction.transactionId,
                data: { ...paymentData },
                status: 'canceled',
            }
        } else {
            return {
                id: transaction.transactionId,
                data: { ...paymentData },
                status: 'pending',
            }
        }
    }

    async getWebhookActionAndData(payload: ProviderWebhookPayload['payload']): Promise<WebhookActionResult> {
        this.logger_.info(`getWebhookActionAndData: ${JSON.stringify(payload)}`);
        const { rawData, headers } = payload;

        const tpayResult = await this.client_.notifications.validateRequest(
            headers as Record<string, string>,
            rawData
        );

        if (!tpayResult.valid) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Invalid TPay webhook payload received.`
            );
        }

        const sessionId = tpayResult.data.transactionHiddenDescription;
        let action: WebhookActionResult['action'] = "pending";

        if (tpayResult.data.transactionStatus === "correct") {
            action = "captured"
        } else if (tpayResult.data.transactionStatus === "canceled") {
            action = "canceled"
        } else {
            action = "pending"
        }

        return {
            action,
            data: {
                session_id: sessionId,
                amount: Number(tpayResult.data.transactionAmount),
            }
        }
    }

    async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
        this.logger_.info(`authorizePayment: ${JSON.stringify(input)}`);
        return {
            data: input.data,
            status: (await this.getPaymentStatus({ data: input.data })).status
        };
    }

    async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
        this.logger_.info(`capturePayment: ${JSON.stringify(input)}`);
        const data = input.data as unknown as TPayPaymentData;

        if (!data || !data.session_id) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Missing or invalid payment data for TPay payment capture.`
            );
        }

        const transaction = await this.client_.transactions.getTransaction(data.tx_id);
        if (transaction.status === "paid") {
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
        this.logger_.info(`refundPayment: ${JSON.stringify(input)}`);
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
        this.logger_.info(`getPaymentStatus: ${JSON.stringify(input)}`);
        const data = input.data as unknown as TPayPaymentData;

        if (!data || !data.session_id) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Missing or invalid payment data for TPay payment status check.`
            );
        }

        const transaction = await this.client_.transactions.getTransaction(data.tx_id);

        if (transaction.status === "paid") {
            return { status: 'authorized' };
        } else if (transaction.status === "canceled") {
            return { status: "canceled" };
        } else {
            return { status: 'pending' };
        }
    }

    async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
        this.logger_.info(`retrievePayment: ${JSON.stringify(input)}`);
        return { data: input.data };
    }

    async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
        this.logger_.info(`cancelPayment: ${JSON.stringify(input)}`);
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
        this.logger_.info(`deletePayment: ${JSON.stringify(input)}`);
        return { data: input.data };
    }

    async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
        this.logger_.info(`updatePayment: ${JSON.stringify(input)}`);
        return { data: input.data };
    }

    getIdentifier(): string {
        return TPayPaymentProviderService.identifier;
    }
}