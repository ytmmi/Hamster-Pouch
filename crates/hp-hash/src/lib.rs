//! hp-hash：内容哈希（BLAKE3）、感知哈希（dHash）、哈希算法版本记录。

mod content;
mod perceptual;

pub use content::{
    CONTENT_HASH_ALGO, CONTENT_HASH_ALGO_VERSION, ContentHash, hash_bytes, hash_file,
};
pub use perceptual::{
    PERCEPTUAL_HASH_ALGO, PERCEPTUAL_HASH_ALGO_VERSION, PerceptualHash, dhash_file, dhash_image,
};
