import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { processPaymentWorkflow, processPaymentWorkflowId } from "@medusajs/medusa/core-flows";

export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
) {
    const payment = req.scope.resolve('payment');
    const logger = req.scope.resolve("logger");
    const workflowEngine = req.scope.resolve("workflows");

    const result = await payment.getWebhookActionAndData({
        provider: "tpay",
        payload: {
            rawData: req.rawBody,
            headers: req.headers,
            data: req.body as any,
        }
    });

    if (!result)
        return res.sendStatus(400);

    try {
        const wflResult = await workflowEngine.run(
            processPaymentWorkflowId,
            {
                input: { ...result },
                throwOnError: true,
                logOnError: true,
            }
        );
    } catch (error) {
        logger.error(`Error processing TPay webhook: ${error}`);
        return res.sendStatus(500);
    }

    return res.send("TRUE").status(200);
}