use wasm_bindgen::prelude::*;

use crate::utils::js_err;

/// Starting chunk size: 64 KiB.
pub const CHUNK_SIZE_MIN: usize = 64 * 1024;
/// Maximum chunk size: 1 MiB.
pub const CHUNK_SIZE_MAX: usize = 1024 * 1024;

// ============================================================================
// Pure Rust core — works in native tests AND WASM
// ============================================================================

/// Compute a BLAKE3 hash over arbitrary data. Returns 32 bytes.
pub fn blake3_hash_raw(data: &[u8]) -> [u8; 32] {
    *blake3::hash(data).as_bytes()
}

/// Hash a chunk with its index prepended to prevent second-preimage attacks
/// across chunk positions.
pub fn hash_chunk_raw(chunk_data: &[u8], chunk_index: u32) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&chunk_index.to_le_bytes());
    hasher.update(chunk_data);
    *hasher.finalize().as_bytes()
}

/// Total number of chunks for a given file size and chunk size.
pub fn chunk_count_raw(file_size: u64, chunk_size: u32) -> u32 {
    if chunk_size == 0 || file_size == 0 {
        return 0;
    }
    let size = chunk_size as u64;
    ((file_size + size - 1) / size) as u32
}

/// Build a Merkle tree from a slice of 32-byte leaf hashes and return the root.
/// Empty input returns the BLAKE3 hash of an empty slice.
/// Odd nodes are duplicated (standard Bitcoin-style Merkle tree).
pub fn compute_merkle_root_raw(leaf_hashes: &[[u8; 32]]) -> [u8; 32] {
    if leaf_hashes.is_empty() {
        return blake3_hash_raw(&[]);
    }

    let mut level: Vec<[u8; 32]> = leaf_hashes.to_vec();

    while level.len() > 1 {
        let mut next: Vec<[u8; 32]> = Vec::with_capacity((level.len() + 1) / 2);
        let mut i = 0;
        while i < level.len() {
            let left = level[i];
            let right = if i + 1 < level.len() { level[i + 1] } else { level[i] };
            let mut combined = [0u8; 64];
            combined[..32].copy_from_slice(&left);
            combined[32..].copy_from_slice(&right);
            next.push(blake3_hash_raw(&combined));
            i += 2;
        }
        level = next;
    }

    level[0]
}

/// Split `data` into `chunk_size`-byte chunks.
/// Returns them as a `Vec<Vec<u8>>` — suitable for native tests and internal use.
pub fn split_chunks_raw(data: &[u8], chunk_size: usize) -> Vec<Vec<u8>> {
    assert!(chunk_size > 0, "chunk_size must be > 0");
    data.chunks(chunk_size).map(|c| c.to_vec()).collect()
}

// ============================================================================
// WASM bindings — thin wrappers that convert between Rust and JS types
// ============================================================================

/// Compute a BLAKE3 hash. Returns a 32-byte Uint8Array.
#[wasm_bindgen(js_name = blake3Hash)]
pub fn blake3_hash(data: &[u8]) -> Vec<u8> {
    blake3_hash_raw(data).to_vec()
}

/// Hash a chunk with its index. Returns a 32-byte Uint8Array.
#[wasm_bindgen(js_name = hashChunk)]
pub fn hash_chunk(chunk_data: &[u8], chunk_index: u32) -> Vec<u8> {
    hash_chunk_raw(chunk_data, chunk_index).to_vec()
}

/// Total number of chunks for a file.
#[wasm_bindgen(js_name = chunkCount)]
pub fn chunk_count(file_size: u64, chunk_size: u32) -> u32 {
    chunk_count_raw(file_size, chunk_size)
}

/// Compute the Merkle root from an Array of 32-byte Uint8Arrays.
/// Returns the 32-byte root hash as a Uint8Array.
#[wasm_bindgen(js_name = computeMerkleRoot)]
pub fn compute_merkle_root(leaf_hashes: js_sys::Array) -> Result<Vec<u8>, JsValue> {
    let mut leaves: Vec<[u8; 32]> = Vec::with_capacity(leaf_hashes.length() as usize);

    for i in 0..leaf_hashes.length() {
        let val = leaf_hashes.get(i);
        let bytes = js_sys::Uint8Array::new(&val).to_vec();
        if bytes.len() != 32 {
            return Err(js_err(format!(
                "leaf hash at index {} must be 32 bytes, got {}",
                i,
                bytes.len()
            )));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        leaves.push(arr);
    }

    Ok(compute_merkle_root_raw(&leaves).to_vec())
}

/// Split data into chunks. Returns an Array of Uint8Arrays.
#[wasm_bindgen(js_name = splitIntoChunks)]
pub fn split_into_chunks(data: &[u8], chunk_size: u32) -> Result<js_sys::Array, JsValue> {
    let size = chunk_size as usize;
    if size == 0 {
        return Err(js_err("chunk_size must be > 0"));
    }
    let result = js_sys::Array::new();
    for chunk in data.chunks(size) {
        result.push(&js_sys::Uint8Array::from(chunk));
    }
    Ok(result)
}

// ============================================================================
// Native unit tests (no js_sys — pure Rust only)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blake3_hash_is_32_bytes() {
        assert_eq!(blake3_hash_raw(b"hello world").len(), 32);
    }

    #[test]
    fn blake3_hash_is_deterministic() {
        assert_eq!(blake3_hash_raw(b"test"), blake3_hash_raw(b"test"));
    }

    #[test]
    fn different_data_different_hash() {
        assert_ne!(blake3_hash_raw(b"a"), blake3_hash_raw(b"b"));
    }

    #[test]
    fn hash_chunk_index_affects_output() {
        let h0 = hash_chunk_raw(b"same data", 0);
        let h1 = hash_chunk_raw(b"same data", 1);
        assert_ne!(h0, h1);
    }

    #[test]
    fn chunk_count_edge_cases() {
        let cs = 64 * 1024u32;
        assert_eq!(chunk_count_raw(0, cs), 0);
        assert_eq!(chunk_count_raw(1, cs), 1);
        assert_eq!(chunk_count_raw(cs as u64, cs), 1);
        assert_eq!(chunk_count_raw(cs as u64 + 1, cs), 2);
        assert_eq!(chunk_count_raw(cs as u64 * 3, cs), 3);
    }

    #[test]
    fn split_chunks_correct_count() {
        let data = vec![0u8; 200 * 1024]; // 200 KiB
        let chunks = split_chunks_raw(&data, 64 * 1024);
        assert_eq!(chunks.len(), 4); // 3 full + 1 partial
        assert_eq!(chunks[0].len(), 64 * 1024);
        assert_eq!(chunks[3].len(), 200 * 1024 - 3 * 64 * 1024);
    }

    #[test]
    fn merkle_root_single_leaf_is_leaf() {
        let leaf = blake3_hash_raw(b"only chunk");
        let root = compute_merkle_root_raw(&[leaf]);
        assert_eq!(root, leaf);
    }

    #[test]
    fn merkle_root_two_leaves() {
        let l0 = blake3_hash_raw(b"chunk0");
        let l1 = blake3_hash_raw(b"chunk1");
        let root = compute_merkle_root_raw(&[l0, l1]);
        // Root must differ from each leaf
        assert_ne!(root, l0);
        assert_ne!(root, l1);
        // Deterministic
        assert_eq!(root, compute_merkle_root_raw(&[l0, l1]));
    }

    #[test]
    fn merkle_root_odd_leaves_duplicates_last() {
        // 3 leaves → level 2 has [hash(l0,l1), hash(l2,l2)] → root = hash of those
        let leaves: Vec<[u8; 32]> = (0u32..3).map(|i| hash_chunk_raw(b"data", i)).collect();
        let root = compute_merkle_root_raw(&leaves);
        assert_eq!(root.len(), 32);
        // Order matters
        let shuffled = [leaves[1], leaves[0], leaves[2]];
        assert_ne!(root, compute_merkle_root_raw(&shuffled));
    }

    #[test]
    fn full_roundtrip_chunk_hash_merkle() {
        let file = b"The quick brown fox jumps over the lazy dog. ".repeat(500);
        let chunk_size = 64 * 1024;
        let chunks = split_chunks_raw(&file, chunk_size);

        let leaf_hashes: Vec<[u8; 32]> = chunks
            .iter()
            .enumerate()
            .map(|(i, c)| hash_chunk_raw(c, i as u32))
            .collect();

        let root = compute_merkle_root_raw(&leaf_hashes);
        assert_eq!(root.len(), 32);

        // Same file → same root
        let root2 = compute_merkle_root_raw(&leaf_hashes);
        assert_eq!(root, root2);
    }
}
