# Experimental Android prototype

The original `app/` and root Gradle project are preserved as historical prototype
code. They are excluded from the web Docker image and web CI. The new service
and browser client do not use Firebase or migrate this prototype's records.

A source review confirms these limitations:

| Area | Existing behavior | Consequence |
| --- | --- | --- |
| Navigation | Only `MainActivity` is declared in the manifest; it starts other activities | The navigation flow is incomplete |
| Signup | The initial signup button targets `FileReceiveActivity` | The button does not open signup |
| File selection | `FileShareActivity.getFileBytes()` returns an empty array | There is no working selected-file read path |
| Recipient lifecycle | Encryption/recipient lookup starts during `onCreate`, before a recipient is selected | Recipient setup is incomplete |
| Key lifecycle | A fresh RSA pair is generated in the sharing activity; durable identity is not established | No reliable peer key lifecycle |
| Receive path | Placeholder file IDs and manually supplied AES keys | No finished receiving workflow |
| Cryptography | Bare `AES`/`RSA` transformation names and whole-array operations | No reviewed authenticated encryption or bounded streaming design |
| Architecture | Files are uploaded to Firebase Storage | This is not the web product's peer transfer model |
| Evidence | No end-to-end test evidence for the prototype | Do not present it as a working secure Android release |

The old README's claims about implemented TLS sockets, a network/security package,
and production-ready secure sharing did not describe this code. The README now
describes the implemented web project. These prototype defects are documented,
not silently fixed as part of the pivot.

A future native client should implement [protocol v1](PROTOCOL.md) and pass
browser/native interoperability tests. It does not block completion of the web
project.
