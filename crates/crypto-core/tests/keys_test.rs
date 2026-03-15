use rand_core::OsRng;
use x25519_dalek::{EphemeralSecret, PublicKey};

#[test]
fn ecdh_both_sides_match() {
    let alice_secret = EphemeralSecret::random_from_rng(OsRng);
    let alice_pk = PublicKey::from(&alice_secret);

    let bob_secret = EphemeralSecret::random_from_rng(OsRng);
    let bob_pk = PublicKey::from(&bob_secret);

    let alice_shared = *alice_secret.diffie_hellman(&bob_pk).as_bytes();
    let bob_shared = *bob_secret.diffie_hellman(&alice_pk).as_bytes();

    assert_eq!(alice_shared, bob_shared, "Shared secrets must match");
    assert_eq!(alice_shared.len(), 32);
    assert_ne!(alice_shared, [0u8; 32], "Shared secret must not be zero");
}

#[test]
fn public_keys_differ_per_keypair() {
    let a = EphemeralSecret::random_from_rng(OsRng);
    let b = EphemeralSecret::random_from_rng(OsRng);
    assert_ne!(
        PublicKey::from(&a).as_bytes(),
        PublicKey::from(&b).as_bytes()
    );
}
