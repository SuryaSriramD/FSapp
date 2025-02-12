# **🔐 FSApp | Secured File Sharing Application**

## **📌 Overview**  
In today’s digital world, secure file sharing is crucial to protect sensitive information from unauthorized access. This **Secured File Sharing Application** ensures encrypted data transfer between devices, preventing cyber threats, unauthorized access, and data breaches.

The app provides a **user-friendly interface** for sharing files over a network while ensuring **end-to-end encryption**. Users can authenticate, select files, and transfer them securely using **cryptographic algorithms** like AES, RSA, and SHA-256.

---

## **🚀 Key Features**  
✔ **End-to-End Encryption** – Ensures that only the sender and recipient can access files.  
✔ **User Authentication** – Secure login and signup using Firebase Authentication.  
✔ **Fast File Transfer** – Efficient sharing of documents, images, videos, and more.  
✔ **Multi-Device Support** – Share files across different Android devices.  
✔ **Seamless UI** – Modern material design for an intuitive experience.  

---

## **🛠️ Technologies Used**  

| **Technology** | **Purpose** |
|--------------|------------|
| **Android (Java)** | Main programming languages for app development. |
| **Firebase Authentication** | Secure user authentication & account management. |
| **Firebase Firestore** | Stores user metadata and file transaction history. |
| **AES (Advanced Encryption Standard)** | Encrypts files before transfer for confidentiality. |
| **RSA (Rivest-Shamir-Adleman)** | Used for secure key exchange. |
| **SHA-256 (Secure Hash Algorithm)** | Ensures data integrity and verifies file authenticity. |
| **Sockets (TCP/IP Protocols)** | Enables peer-to-peer file sharing over a network. |
| **Figma** | Designed a smooth and modern user interface. |

---

## **🔑 Security Mechanisms & Algorithms**  

### **1️⃣ AES (Advanced Encryption Standard) – File Encryption**
- AES-256 is used to encrypt files before they are sent.  
- The encrypted file is stored temporarily and then transmitted securely.  

```java
SecretKey key = generateAESKey();
Cipher cipher = Cipher.getInstance("AES");
cipher.init(Cipher.ENCRYPT_MODE, key);
byte[] encryptedData = cipher.doFinal(fileBytes);
```

---

### **2️⃣ RSA (Rivest-Shamir-Adleman) – Key Exchange**
- RSA ensures that the AES encryption key is securely shared between sender and receiver.  

```java
Cipher cipher = Cipher.getInstance("RSA");
cipher.init(Cipher.ENCRYPT_MODE, receiverPublicKey);
byte[] encryptedKey = cipher.doFinal(aesKey.getEncoded());
```

---

### **3️⃣ SHA-256 (Secure Hash Algorithm) – Data Integrity Check**
- SHA-256 is used to verify file integrity before and after transfer.
- Helps in detecting any tampering or corruption of files.

```java
MessageDigest digest = MessageDigest.getInstance("SHA-256");
byte[] hash = digest.digest(fileBytes);
String checksum = Base64.getEncoder().encodeToString(hash);
```

---

### **4️⃣ Secure Socket Communication (TCP/IP)**
- Uses **Java Sockets** to establish a secure connection between sender and receiver.  

```java
Socket socket = new Socket(receiverIP, PORT);
OutputStream outputStream = socket.getOutputStream();
outputStream.write(encryptedFile);
```

---

## **📂 Project Structure**
```
SecuredFileSharingApplication/
│── app/
│   ├── src/main/java/com/example/
│   │   ├── activities/
│   │   │   ├── LoginActivity.java
│   │   │   ├── SignUpActivity.java
│   │   │   ├── DashboardActivity.java
│   │   │   ├── FileShareActivity.java
│   │   │   ├── FileReceiveActivity.java
│   │   ├── models/
│   │   │   ├── User.java
│   │   │   ├── FileMetadata.java
│   │   ├── security/
│   │   │   ├── AESUtils.java
│   │   │   ├── RSAUtils.java
│   │   │   ├── HashUtils.java
│   │   ├── network/
│   │   │   ├── SocketClient.java
│   │   │   ├── SocketServer.java
│── res/layout/
│── res/values/
│── AndroidManifest.xml
│── build.gradle
│── settings.gradle
```

---

## **⚙️ How It Works (Workflow)**  

### **1️⃣ User Authentication**
- **New users:** Sign up with email & password (Firebase Authentication).  
- **Existing users:** Login securely to access the app.  

### **2️⃣ File Encryption & Sharing**
- **User selects a file** → Encrypts it using AES-256.  
- **AES key is encrypted** using RSA (receiver’s public key).  
- **File checksum is generated** using SHA-256 for integrity verification.  
- **Encrypted file + encrypted AES key + checksum** is sent via **Secure Socket Layer (SSL/TLS)**.  

### **3️⃣ File Reception & Decryption**
- **Receiver gets the encrypted file**, **AES key**, and **checksum**.  
- **Decrypts the AES key** using their RSA private key.  
- **Uses the decrypted AES key** to decrypt the file and restore it.  
- **Verifies the file integrity** by comparing SHA-256 checksums.  

---

---

## **🚀 Future Enhancements**
- **📱 Cross-Platform Support** – Extend support to iOS & Web.  
- **🌐 Cloud Backup** – Store encrypted files in the cloud securely.  
- **📊 Transfer Logs** – Maintain a history of file transfers.  
- **🔍 Malware Scanning** – Scan files before sharing for extra security.  

---

## **🔧 Setup & Installation**
1️⃣ **Clone the repository**  
```sh
git clone https://github.com/SuryaSriramD/FSapp.git
cd FSapp
```
2️⃣ **Open in Android Studio**  
3️⃣ **Run the application** on a real device or emulator.  

---

## **📢 Conclusion**
This **Secured File Sharing Application** provides a **fast, reliable, and secure** way to transfer files between devices. By implementing **AES, RSA, SHA-256, and Secure Socket Layer (SSL/TLS)**, we ensure complete **privacy and protection** from cyber threats.  

💡 **_Stay secure, share smart!_** 💡

