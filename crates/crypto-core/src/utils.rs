use wasm_bindgen::prelude::*;

/// Initializes the panic hook so Rust panics show readable messages in the browser console.
/// Call once at startup. No-op on non-WASM targets.
pub fn set_panic_hook() {
    console_error_panic_hook::set_once();
}

/// Generic error type exposed to JavaScript.
#[wasm_bindgen]
pub struct SecureDropError {
    message: String,
}

#[wasm_bindgen]
impl SecureDropError {
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }
}

impl From<String> for SecureDropError {
    fn from(s: String) -> Self {
        SecureDropError { message: s }
    }
}

impl From<&str> for SecureDropError {
    fn from(s: &str) -> Self {
        SecureDropError { message: s.to_owned() }
    }
}

/// Convert a Rust error into a JS-throwable value.
pub fn js_err(msg: impl Into<String>) -> JsValue {
    JsValue::from_str(&msg.into())
}
