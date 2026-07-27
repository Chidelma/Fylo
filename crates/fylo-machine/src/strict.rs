//! JSON value that rejects duplicate object keys.
//!
//! `serde_json` keeps the last duplicate key. The machine contract requires
//! rejection, because two clients disagreeing on which value wins is exactly
//! the kind of silent divergence the protocol is meant to prevent.

use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

/// A parsed JSON value whose objects contained no duplicate keys.
#[derive(Clone, Debug, PartialEq)]
pub struct StrictValue(Value);

impl StrictValue {
    /// Consume the wrapper and return the plain value.
    #[must_use]
    pub fn into_inner(self) -> Value {
        self.0
    }
}

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(StrictValue)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        Ok(Number::from_f64(value).map_or(Value::Null, Value::Number))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<StrictValue>()? {
            values.push(value.0);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut fields = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            let value = map.next_value::<StrictValue>()?;
            if fields.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate key `{key}`")));
            }
            fields.insert(key, value.0);
        }
        Ok(Value::Object(fields))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_duplicate_keys_are_rejected() {
        let error = serde_json::from_str::<StrictValue>(r#"{"a":{"b":1,"b":2}}"#).unwrap_err();
        assert!(error.to_string().contains("duplicate key"));
    }

    #[test]
    fn distinct_keys_round_trip() {
        let value = serde_json::from_str::<StrictValue>(r#"{"a":[1,{"b":true}],"c":null}"#)
            .unwrap()
            .into_inner();
        assert_eq!(value["a"][1]["b"], Value::Bool(true));
        assert_eq!(value["c"], Value::Null);
    }
}
