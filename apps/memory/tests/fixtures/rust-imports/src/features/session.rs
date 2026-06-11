use std::collections::HashMap;
use crate::auth::{Session, TokenStore as Store};
use self::models::{User, profile::{Avatar, Bio}};
use super::prelude::*;
pub use anyhow::Result;
extern crate serde_json as json;

pub fn start_session() -> Result<()> {
  let _cache: HashMap<String, Session> = HashMap::new();
  Ok(())
}
