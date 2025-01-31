package com.example.secured_file_sharing_application;

import android.os.Bundle;
import android.util.Base64;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;
import androidx.annotation.NonNull;
import android.widget.Button;

import java.util.HashMap;
import java.util.Map;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import java.security.KeyFactory;
import java.security.spec.X509EncodedKeySpec;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.storage.FirebaseStorage;
import com.google.firebase.database.DataSnapshot;
import com.google.firebase.database.DatabaseError;
import com.google.firebase.database.ValueEventListener;
import com.google.firebase.database.DatabaseReference;
import com.google.firebase.database.FirebaseDatabase;
import com.google.firebase.storage.StorageReference;
import com.google.firebase.storage.UploadTask;


public class FileShareActivity extends AppCompatActivity {
    private String recipientId;
    private SecretKey aesKey;
    private KeyPair rsaKeyPair;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_file_share);

        // Initialize RSA key pair (if not already generated for the user)
        generateRSAKeyPair();

        // Select and encrypt the file
        selectAndEncryptFile();
        // Set up Share button functionality
        Button shareButton = findViewById(R.id.btn_share_file);
        shareButton.setOnClickListener(v -> {
            if (recipientId != null && !recipientId.isEmpty()) {
                shareFileWithRecipient();
            } else {
                Toast.makeText(this, "Please select a recipient first", Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void generateRSAKeyPair() {
        try {
            KeyPairGenerator keyPairGenerator = KeyPairGenerator.getInstance("RSA");
            keyPairGenerator.initialize(2048);
            rsaKeyPair = keyPairGenerator.generateKeyPair();
        } catch (Exception e) {
            Toast.makeText(this, "RSA Key Pair Generation Failed", Toast.LENGTH_SHORT).show();
        }
    }

    private void selectAndEncryptFile() {
        try {
            // Generate AES key
            KeyGenerator keyGen = KeyGenerator.getInstance("AES");
            keyGen.init(256);
            aesKey = keyGen.generateKey();

            // Encrypt the file (assuming file content is in byte[] fileBytes)
            byte[] fileBytes = getFileBytes(); // Method to get the file bytes
            byte[] encryptedFile = encryptAES(fileBytes, aesKey);

            // Generate SHA-256 hash for integrity check
            byte[] sha256Hash = generateSHA256Hash(fileBytes);

            // Retrieve recipient public key asynchronously
            getRecipientPublicKey(new PublicKeyCallback() {
                @Override
                public void onPublicKeyRetrieved(PublicKey recipientPublicKey) {
                    try {
                        // Encrypt AES key with RSA after retrieving the public key
                        byte[] encryptedAESKey = encryptAESKeyWithRSA(aesKey, recipientPublicKey);

                        // Upload encrypted file, hash, and encrypted AES key to Firebase
                        uploadToFirebase(encryptedFile, sha256Hash, encryptedAESKey);
                    } catch (Exception e) {
                        Toast.makeText(FileShareActivity.this, "Encryption failed", Toast.LENGTH_SHORT).show();
                    }
                }

                @Override
                public void onError(String errorMessage) {
                    Toast.makeText(FileShareActivity.this, errorMessage, Toast.LENGTH_SHORT).show();
                }
            });

        } catch (Exception e) {
            Toast.makeText(this, "File Encryption Failed", Toast.LENGTH_SHORT).show();
        }
    }


    private byte[] getFileBytes() {
        // Placeholder method to retrieve file bytes from user-selected file
        return new byte[0];
    }

    private byte[] encryptAES(byte[] data, SecretKey aesKey) throws Exception {
        Cipher cipher = Cipher.getInstance("AES");
        cipher.init(Cipher.ENCRYPT_MODE, aesKey);
        return cipher.doFinal(data);
    }

    private byte[] generateSHA256Hash(byte[] data) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return digest.digest(data);
    }

    private byte[] encryptAESKeyWithRSA(SecretKey aesKey, PublicKey recipientPublicKey) throws Exception {
        Cipher cipher = Cipher.getInstance("RSA");
        cipher.init(Cipher.ENCRYPT_MODE, recipientPublicKey);
        return cipher.doFinal(aesKey.getEncoded());
    }

    // Callback interface
    public interface PublicKeyCallback {
        void onPublicKeyRetrieved(PublicKey publicKey);
        void onError(String errorMessage);
    }


    private void getRecipientPublicKey(PublicKeyCallback callback) {
        DatabaseReference publicKeyRef = FirebaseDatabase.getInstance().getReference("users").child(recipientId).child("publicKey");

        publicKeyRef.addListenerForSingleValueEvent(new ValueEventListener() {
            @Override
            public void onDataChange(@NonNull DataSnapshot dataSnapshot) {
                if (dataSnapshot.exists()) {
                    String publicKeyBase64 = dataSnapshot.getValue(String.class);
                    try {
                        byte[] publicKeyBytes = Base64.decode(publicKeyBase64, Base64.DEFAULT);
                        KeyFactory keyFactory = KeyFactory.getInstance("RSA");
                        X509EncodedKeySpec keySpec = new X509EncodedKeySpec(publicKeyBytes);

                        // Retrieve the PublicKey and pass it to the callback
                        PublicKey publicKey = keyFactory.generatePublic(keySpec);
                        callback.onPublicKeyRetrieved(publicKey);
                    } catch (Exception e) {
                        callback.onError("Public Key Decoding Failed");
                    }
                } else {
                    callback.onError("Public Key not found");
                }
            }

            @Override
            public void onCancelled(@NonNull DatabaseError databaseError) {
                callback.onError("Error retrieving public key");
            }
        });
    }

    // Assuming you have a method to set the recipient when the user selects one
    public void setRecipient(String selectedRecipientId) {
        this.recipientId = selectedRecipientId;
    }

    // Example Firebase database structure assumed: "users" -> userId -> "recipientId"
    private void fetchRecipientId(String recipientUsername, byte[] encryptedFile, byte[] sha256Hash, byte[] encryptedAESKey) {
        DatabaseReference usersRef = FirebaseDatabase.getInstance().getReference("users");

        usersRef.orderByChild("username").equalTo(recipientUsername)
                .addListenerForSingleValueEvent(new ValueEventListener() {
                    @Override
                    public void onDataChange(@NonNull DataSnapshot dataSnapshot) {
                        if (dataSnapshot.exists()) {
                            for (DataSnapshot userSnapshot : dataSnapshot.getChildren()) {
                                recipientId = userSnapshot.getKey();
                                // Proceed with the file upload now that recipientId is set
                                uploadToFirebase(encryptedFile, sha256Hash, encryptedAESKey);
                            }
                        } else {
                            Toast.makeText(FileShareActivity.this, "Recipient not found", Toast.LENGTH_SHORT).show();
                        }
                    }

                    @Override
                    public void onCancelled(@NonNull DatabaseError databaseError) {
                        Toast.makeText(FileShareActivity.this, "Error retrieving recipient ID", Toast.LENGTH_SHORT).show();
                    }
                });
    }
    private void shareFileWithRecipient() {
        if (aesKey == null || rsaKeyPair == null) {
            Toast.makeText(this, "Encryption keys are not initialized", Toast.LENGTH_SHORT).show();
            return;
        }

        // Generate and encrypt the file data
        try {
            byte[] fileBytes = getFileBytes(); // Get the bytes of the selected file
            byte[] encryptedFile = encryptAES(fileBytes, aesKey); // Encrypt the file with AES key
            byte[] sha256Hash = generateSHA256Hash(fileBytes); // Generate SHA-256 hash

            // Retrieve recipient's public key and proceed with uploading
            getRecipientPublicKey(new PublicKeyCallback() {
                @Override
                public void onPublicKeyRetrieved(PublicKey recipientPublicKey) {
                    try {
                        // Encrypt AES key using recipient's RSA public key
                        byte[] encryptedAESKey = encryptAESKeyWithRSA(aesKey, recipientPublicKey);

                        // Upload encrypted file, hash, and encrypted AES key to Firebase
                        uploadToFirebase(encryptedFile, sha256Hash, encryptedAESKey);
                    } catch (Exception e) {
                        Toast.makeText(FileShareActivity.this, "Error encrypting AES key with recipient's public key", Toast.LENGTH_SHORT).show();
                    }
                }

                @Override
                public void onError(String errorMessage) {
                    Toast.makeText(FileShareActivity.this, errorMessage, Toast.LENGTH_SHORT).show();
                }
            });

        } catch (Exception e) {
            Toast.makeText(this, "Error encrypting the file", Toast.LENGTH_SHORT).show();
        }
    }


    private void uploadToFirebase(byte[] encryptedFile, byte[] sha256Hash, byte[] encryptedAESKey) {
        // Check if recipientId is valid
        if (recipientId == null || recipientId.isEmpty()) {
            Toast.makeText(this, "Recipient ID is missing", Toast.LENGTH_SHORT).show();
            return;
        }

        // Firebase references
        FirebaseStorage storage = FirebaseStorage.getInstance();
        FirebaseDatabase database = FirebaseDatabase.getInstance();

        // Get the current user ID (the sender's ID)
        String userId = FirebaseAuth.getInstance().getCurrentUser().getUid();

        // Generate a unique file ID for each upload
        String fileId = database.getReference("files").push().getKey();
        if (fileId == null) {
            Toast.makeText(this, "Failed to generate file ID", Toast.LENGTH_SHORT).show();
            return;
        }

        // Reference for storing the encrypted file in Firebase Storage
        StorageReference fileRef = storage.getReference().child("encrypted_files/" + fileId + ".enc");

        // Upload encrypted file to Firebase Storage
        UploadTask uploadTask = fileRef.putBytes(encryptedFile);
        uploadTask.addOnSuccessListener(taskSnapshot -> {
            // If file upload is successful, get the download URL of the uploaded file
            fileRef.getDownloadUrl().addOnSuccessListener(downloadUri -> {
                // Define the reference for storing metadata in Firebase Database
                DatabaseReference fileMetadataRef = database.getReference("files").child(userId).child(fileId);

                // Prepare metadata to store in Firebase Database
                Map<String, Object> fileData = new HashMap<>();
                fileData.put("fileUrl", downloadUri.toString()); // URL of the encrypted file
                fileData.put("sha256Hash", Base64.encodeToString(sha256Hash, Base64.DEFAULT)); // SHA-256 hash of the file
                fileData.put("encryptedAESKey", Base64.encodeToString(encryptedAESKey, Base64.DEFAULT)); // Encrypted AES key
                fileData.put("recipientId", recipientId); // The recipient's user ID

                // Upload metadata to Firebase Database
                fileMetadataRef.setValue(fileData).addOnCompleteListener(task -> {
                    if (task.isSuccessful()) {
                        Toast.makeText(FileShareActivity.this, "File uploaded successfully", Toast.LENGTH_SHORT).show();
                    } else {
                        Toast.makeText(FileShareActivity.this, "Failed to upload file metadata", Toast.LENGTH_SHORT).show();
                    }
                });
            });
        }).addOnFailureListener(e -> {
            // If the file upload fails, show an error message
            Toast.makeText(FileShareActivity.this, "File upload failed: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        });
    }

}


