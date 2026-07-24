import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().default("postgres://relay:relay@localhost:5432/relay"),
  JWT_SECRET: z.string().min(32).default("development-only-change-this-secret-32"),
  DATA_ENCRYPTION_KEY: z.string().min(32).default("development-data-key-change-this-32"),
  ADMIN_EMAIL: z.string().email().default("admin@relay.local"),
  ADMIN_PASSWORD: z.string().min(10).default("ChangeMe123!"),
  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("relay-media"),
  S3_ACCESS_KEY: z.string().default("relay"),
  S3_SECRET_KEY: z.string().default("relay-secret-change-me"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).optional(),
});

const parsed=schema.parse(process.env);
if(parsed.NODE_ENV==="production"&&!parsed.META_GRAPH_API_VERSION)throw new Error("META_GRAPH_API_VERSION is required in production");
export const config={...parsed,META_GRAPH_API_VERSION:parsed.META_GRAPH_API_VERSION??"v26.0"};
