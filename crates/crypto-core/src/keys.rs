use wasm_bindgen::prelude::*;
use rand_core::OsRng;
use x25519_dalek::{EphemeralSecret, PublicKey};

use crate::utils::js_err;

/// An ephemeral X25519 keypair.
/// The private key is consumed during key exchange and cannot be reused.
#[wasm_bindgen]
pub struct Keypair {
    secret: Option<EphemeralSecret>,
    public_key_bytes: [u8; 32],
}

#[wasm_bindgen]
impl Keypair {
    /// Generate a new ephemeral X25519 keypair.
    /// Uses `crypto.getRandomValues()` in the browser (via getrandom/js feature).
    #[wasm_bindgen(constructor)]
    pub fn generate() -> Keypair {
        let secret = EphemeralSecret::random_from_rng(OsRng);
        let public_key = PublicKey::from(&secret);
        Keypair {
            public_key_bytes: *public_key.as_bytes(),
            secret: Some(secret),
        }
    }

    /// Returns the 32-byte public key as a Uint8Array.
    #[wasm_bindgen(getter, js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.public_key_bytes.to_vec()
    }

    /// Perform X25519 ECDH with the remote party's 32-byte public key.
    /// Consumes the secret — this `Keypair` cannot be used again after this call.
    /// Returns the 32-byte raw shared secret (pass through HKDF before use as encryption key).
    #[wasm_bindgen(js_name = diffieHellman)]
    pub fn diffie_hellman(&mut self, their_public_key: &[u8]) -> Result<Vec<u8>, JsValue> {
        if their_public_key.len() != 32 {
            return Err(js_err(format!(
                "their_public_key must be 32 bytes, got {}",
                their_public_key.len()
            )));
        }
        let secret = self
            .secret
            .take()
            .ok_or_else(|| js_err("Keypair already consumed — create a new one per transfer"))?;

        let mut pk_bytes = [0u8; 32];
        pk_bytes.copy_from_slice(their_public_key);
        let their_pk = PublicKey::from(pk_bytes);

        let shared = secret.diffie_hellman(&their_pk);
        Ok(shared.as_bytes().to_vec())
        // EphemeralSecret + SharedSecret are zeroized on drop by x25519-dalek
    }
}

// ---------------------------------------------------------------------------
// Pure Rust helpers (usable in native unit tests)
// ---------------------------------------------------------------------------

/// Generate an ephemeral keypair and perform ECDH in one call.
/// Returns `(our_public_key, shared_secret)`.
/// Only used internally for testing.
#[cfg(test)]
pub(crate) fn generate_and_exchange() -> ([u8; 32], [u8; 32], [u8; 32]) {
    let alice_secret = EphemeralSecret::random_from_rng(OsRng);
    let alice_pk = *PublicKey::from(&alice_secret).as_bytes();

    let bob_secret = EphemeralSecret::random_from_rng(OsRng);
    let bob_pk = *PublicKey::from(&bob_secret).as_bytes();

    let alice_shared = *alice_secret
        .diffie_hellman(&PublicKey::from(bob_pk))
        .as_bytes();
    let bob_shared = *bob_secret
        .diffie_hellman(&PublicKey::from(alice_pk))
        .as_bytes();

    assert_eq!(alice_shared, bob_shared, "shared secrets must match");
    (alice_pk, bob_pk, alice_shared)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecdh_shared_secret_matches() {
        let (_, _, shared) = generate_and_exchange();
        assert_eq!(shared.len(), 32);
        // Not all-zero (would indicate a low-order point attack)
        assert_ne!(shared, [0u8; 32]);
    }

    #[test]
    fn public_keys_are_unique_per_keypair() {
        let a = EphemeralSecret::random_from_rng(OsRng);
        let b = EphemeralSecret::random_from_rng(OsRng);
        let a_pk = *PublicKey::from(&a).as_bytes();
        let b_pk = *PublicKey::from(&b).as_bytes();
        assert_ne!(a_pk, b_pk);
    }
}
