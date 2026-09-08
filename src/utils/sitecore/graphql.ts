// utils/sitecore/graphql.ts

import type { ClientSDK } from "@sitecore-marketplace-sdk/client";

export const DATABASE = "master";

export interface GraphQLBody<T> {
  data?: T;
  errors?: Array<{ message?: string; path?: Array<string> }>;
}

export async function runGraphQL<T>(
  client: ClientSDK,
  sitecoreContextId: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphQLBody<T>> {
  const response = (await client.mutate("xmc.authoring.graphql", {
    params: {
      query: { sitecoreContextId },
      body: { query, variables },
    },
  })) as { data?: GraphQLBody<T> } & GraphQLBody<T>;

  // The SDK wraps the HTTP response, so the GraphQL envelope sits one level deeper.
  const body = (response?.data ?? response) as GraphQLBody<T>;

  if (!body) {
    throw new Error("Empty response from the Authoring API.");
  }

  return body;
}

export function normalizeGuid(id: string): string {
  const clean = id.replace(/[{}\s-]/g, "").toUpperCase();
  if (clean.length !== 32) {
    return id;
  }
  const formatted = clean.replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    "$1-$2-$3-$4-$5",
  );
  return `{${formatted}}`;
}
