import { defineMiddlewares, MiddlewaresConfig } from "@medusajs/framework";

export const config: MiddlewaresConfig = {
    routes: [
        {
            methods: ["POST"],
            matcher: "/hooks/payment/tpay",
            bodyParser: { preserveRawBody: true },
        }
    ]
};

export default defineMiddlewares(config);