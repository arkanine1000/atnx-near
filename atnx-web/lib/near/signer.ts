// The browser half of the signer, ported from near/relayer-proto/client.mjs:
// a near-api-js Signer backed by a WebCrypto Ed25519 key. In the browser,
// generate() makes a NON-extractable private key; IndexedDB stores the
// CryptoKey as it is (structured clone keeps it), and page script can sign
// with it but never read the key bytes out. Only WebCrypto and near-api-js,
// so Node 20 or later runs the same code (scripts/near-relay-e2e.ts).
import { KeyType, PublicKey, Signer, base64Encode, baseDecode, type KeyPair } from 'near-api-js';

const b64url = (bytes: Uint8Array) => base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Ed25519 in WebCrypto: Chrome 137+, Firefox 129+, Safari 17+, Node 20+.
export async function webCryptoEd25519Supported(): Promise<boolean> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return false;
    const k = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    return !!k.privateKey;
  } catch {
    return false;
  }
}

export class WebCryptoSigner extends Signer {
  readonly publicKey: PublicKey;

  constructor(
    readonly privateKey: CryptoKey,
    publicKeyBytes: Uint8Array,
  ) {
    super();
    this.publicKey = new PublicKey({ keyType: KeyType.ED25519, data: publicKeyBytes });
  }

  // A fresh key pair whose private half can never be exported.
  static async generate(): Promise<WebCryptoSigner> {
    const { privateKey, publicKey } = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
    return new WebCryptoSigner(privateKey, raw);
  }

  // For scripts: an existing near-api-js KeyPair as a non-extractable key.
  static async fromKeyPair(keyPair: KeyPair): Promise<WebCryptoSigner> {
    const secret = baseDecode(keyPair.toString().split(':')[1]); // 64 bytes: seed || public key
    const seed = secret.slice(0, 32);
    const pub = keyPair.getPublicKey().data;
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', d: b64url(seed), x: b64url(pub) },
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    return new WebCryptoSigner(privateKey, Uint8Array.from(pub));
  }

  // "ed25519:<base58>"
  get publicKeyString(): string {
    return this.publicKey.toString();
  }

  async getPublicKey(): Promise<PublicKey> {
    return this.publicKey;
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, this.privateKey, bytes as Uint8Array<ArrayBuffer>));
  }
}
