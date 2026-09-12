//! hp-hash：内容哈希（BLAKE3）、感知哈希（dHash）、哈希算法版本记录。

mod content;
mod perceptual;

pub use content::{
    hash_bytes, hash_file, ContentHash, CONTENT_HASH_ALGO, CONTENT_HASH_ALGO_VERSION,
};
pub use perceptual::{
    dhash_file, dhash_image, PerceptualHash, PERCEPTUAL_HASH_ALGO, PERCEPTUAL_HASH_ALGO_VERSION,
};
