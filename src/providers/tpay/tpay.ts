import { AbstractPaymentProvider } from '@medusajs/framework/utils';
import { Logger } from '@medusajs/medusa';
import { z } from 'zod';

export const TPayOptionsSchema = z.object({
    clientId: z.coerce.number(),
    clientSecret: z.string(),
    sandbox: z.boolean().optional().default(true),
    returnUrl: z.string().url(),
    callbackUrl: z.string().url(),
    title: z.string().optional(),
    refundDescription: z.string().optional(),
});

export type TPayOptions = z.infer<typeof TPayOptionsSchema>;

export const InitiatePaymentSchema = z.object({
    session_id: z.string(),
    email: z.string().email(),
    customer_ip: z.string(),
});

interface TPayPaymentData {

}

type InjectedDeps = {
    logger: Logger;
}

export class TPayPaymentProviderService extends AbstractPaymentProvider<TPayOptions> {
    static identifier = 'tpay';

    protected logger_: Logger;
    protected options_: PayUOptions;
    protected client_: PayU;

    constructor(options: TPayOptions, container: InjectedDeps) {
        super(options, container);


    }
}