import { getAssetFromKV, NotFoundError } from '@cloudflare/kv-asset-handler'

interface Env {
  __STATIC_CONTENT: KVNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const asset = await getAssetFromKV(
        {
          request,
          waitUntil: (promise) => {},
        },
        {
          ASSET_NAMESPACE: env.__STATIC_CONTENT,
          ASSET_MANIFEST: (ASSET_MANIFEST as any),
        }
      )
      return asset
    } catch (e) {
      if (e instanceof NotFoundError) {
        return new Response('Not found', { status: 404 })
      }
      return new Response('Internal server error', { status: 500 })
    }
  },
}

declare const ASSET_MANIFEST: string
