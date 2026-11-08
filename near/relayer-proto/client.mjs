// The browser half: sign a NEP-366 DelegateAction with the user's key.
// Uses only WebCrypto and near-api-js, so the same code runs in a browser.
import {
  Account, JsonRpcProvider, KeyType, PublicKey, Signer,
  actions, base64Encode, baseDecode, encodeSignedDelegate, teraToGas,
} from "near-api-js";

const b64url = (bytes) => base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * A near-api-js Signer backed by a WebCrypto Ed25519 CryptoKey.
 * In the browser, generate() makes a NON-extractable private key that can be stored
 * in IndexedDB as-is (structured clone keeps the CryptoKey); page script can sign
 * with it but cannot read the key bytes out.
 */
export class WebCryptoSigner extends Signer {
  constructor(privateKey, publicKeyBytes) {
    super();
    this.privateKey = privateKey;
    this.publicKey = new PublicKey({ keyType: KeyType.ED25519, data: publicKeyBytes });
  }

  static async generate() {
    const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    return new WebCryptoSigner(privateKey, raw);
  }

  /** For the probe: import an existing near-api-js KeyPair as a non-extractable CryptoKey. */
  static async fromKeyPair(keyPair) {
    const secret = baseDecode(keyPair.secretKey); // 64 bytes: seed || public key
    const seed = secret.slice(0, 32);
    const pub = keyPair.getPublicKey().data;
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", d: b64url(seed), x: b64url(pub) },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    return new WebCryptoSigner(privateKey, Uint8Array.from(pub));
  }

  async getPublicKey() {
    return this.publicKey;
  }

  async signBytes(bytes) {
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, this.privateKey, bytes));
  }
}

/**
 * Build and sign a delegate action for one zero-deposit call. Returns base64 borsh SignedDelegate,
 * which is what the browser POSTs to /api/relay.
 * Reads the key's nonce and the block height from RPC (the relayer could serve these instead).
 */
export async function signCall({ rpcUrl, accountId, signer, contractId, methodName, args = {}, gas = teraToGas("30"), ttlBlocks = 200 }) {
  const account = new Account(accountId, new JsonRpcProvider({ url: rpcUrl }), signer);
  const { signedDelegate, delegateHash } = await account.createSignedMetaTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(methodName, args, gas, 0n)],
    blockHeightTtl: ttlBlocks,
  });
  return {
    signedDelegateBase64: base64Encode(encodeSignedDelegate(signedDelegate)),
    delegateHash: base64Encode(delegateHash),
    nonce: signedDelegate.delegateAction.nonce,
  };
}
