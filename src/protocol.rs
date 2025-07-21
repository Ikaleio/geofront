//! proxy_core/src/protocol.rs
//! Minecraft protocol parsing and serialization utilities

use crate::types::HandshakeData;
use std::io::{Error, ErrorKind, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Reads a VarInt (max 5 bytes) from the provided stream.
pub async fn read_varint<R>(stream: &mut R) -> Result<i32>
where
    R: AsyncReadExt + Unpin,
{
    let mut num_read = 0;
    let mut result = 0;
    loop {
        let byte = stream.read_u8().await?;
        let value = (byte & 0x7F) as i32;
        result |= value << (7 * num_read);
        num_read += 1;
        if num_read > 5 {
            return Err(Error::new(ErrorKind::InvalidData, "VarInt too big"));
        }
        if (byte & 0x80) == 0 {
            break;
        }
    }
    Ok(result)
}

/// Writes a VarInt to the buffer.
fn write_varint(buf: &mut Vec<u8>, mut value: i32) {
    loop {
        if (value & !0x7F) == 0 {
            buf.push(value as u8);
            return;
        }
        buf.push(((value & 0x7F) | 0x80) as u8);
        value = ((value as u32) >> 7) as i32;
    }
}

/// Reads a length-prefixed UTF-8 string (VarInt length + bytes) from the stream.
pub async fn read_string<R>(stream: &mut R) -> Result<String>
where
    R: AsyncReadExt + Unpin,
{
    let len = read_varint(stream).await? as usize;
    // Add a reasonable limit to prevent memory exhaustion attacks.
    // 262144 bytes (256 KiB) is a generous limit for a single packet string.
    if len > 262144 {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "String length exceeds limit",
        ));
    }
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await?;
    String::from_utf8(buf).map_err(|e| Error::new(ErrorKind::InvalidData, e))
}

/// Writes a length-prefixed UTF-8 string into the buffer.
fn write_string(buf: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    write_varint(buf, bytes.len() as i32);
    buf.extend_from_slice(bytes);
}

/// Sends a Login Disconnect packet with the given message, then closes the stream.
pub async fn write_disconnect<S>(stream: &mut S, msg: &str) -> Result<()>
where
    S: AsyncWriteExt + Unpin,
{
    // Build packet payload: [PacketID VarInt=0] [String reason]
    let mut payload = Vec::new();
    write_varint(&mut payload, 0); // Disconnect packet ID in Login state
    write_string(&mut payload, msg);

    // Prepend length VarInt
    let mut packet = Vec::new();
    write_varint(&mut packet, payload.len() as i32);
    packet.extend(payload);

    // Send and shutdown
    stream.write_all(&packet).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

pub async fn parse_handshake<R>(stream: &mut R) -> Result<HandshakeData>
where
    R: AsyncReadExt + Unpin,
{
    let _packet_len = read_varint(stream).await?;
    let packet_id = read_varint(stream).await?;
    if packet_id != 0 {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "Invalid handshake packet ID",
        ));
    }
    let protocol_version = read_varint(stream).await?;
    let host = read_string(stream).await?;
    let port = stream.read_u16().await?;
    let next_state = read_varint(stream).await?;
    Ok(HandshakeData {
        protocol_version,
        host,
        port,
        next_state,
    })
}

pub async fn parse_login_start<R>(stream: &mut R) -> Result<String>
where
    R: AsyncReadExt + Unpin,
{
    let _packet_len = read_varint(stream).await?;
    let packet_id = read_varint(stream).await?;
    if packet_id != 0 {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "Invalid login start packet ID",
        ));
    }
    read_string(stream).await
}
