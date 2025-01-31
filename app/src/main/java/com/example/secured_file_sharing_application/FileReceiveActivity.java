package com.example.secured_file_sharing_application;

import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import com.google.firebase.database.DataSnapshot;
import com.google.firebase.database.DatabaseError;
import com.google.firebase.database.DatabaseReference;
import com.google.firebase.database.FirebaseDatabase;
import com.google.firebase.storage.FirebaseStorage;
import com.google.firebase.storage.StorageReference;
import java.io.InputStream;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

public class FileReceiveActivity extends AppCompatActivity {

    private EditText decryptionCodeInput;
    private Button decryptButton;
    private ProgressBar decryptionProgress;
    private TextView decryptedContentText;

    private DatabaseReference database;
    private StorageReference storageRef;
    private String fileId = "your_file_id"; // Replace with the specific file ID to retrieve

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_file_receive);

        decryptionCodeInput = findViewById(R.id.decryption_code_input);
        decryptButton = findViewById(R.id.decrypt_button);
        decryptionProgress = findViewById(R.id.decryption_progress);
        decryptedContentText = findViewById(R.id.decrypted_content_text);

        database = FirebaseDatabase.getInstance().getReference("Files");
        storageRef = FirebaseStorage.getInstance().getReference("encrypted_files/" + fileId + ".enc");

        decryptButton.setOnClickListener(v -> decryptFile());
    }

    private void decryptFile() {
        String decryptionCode = decryptionCodeInput.getText().toString().trim();
        if (decryptionCode.isEmpty()) {
            Toast.makeText(this, "Please enter the decryption code", Toast.LENGTH_SHORT).show();
            return;
        }

        decryptionProgress.setVisibility(View.VISIBLE);

        // Retrieve the encrypted file from Firebase Storage
        storageRef.getBytes(Long.MAX_VALUE).addOnSuccessListener(this::decryptAndDisplayContent)
                .addOnFailureListener(e -> {
                    decryptionProgress.setVisibility(View.GONE);
                    Toast.makeText(this, "Failed to retrieve the file", Toast.LENGTH_SHORT).show();
                    Log.e("FileReceiveActivity", "File retrieval failed", e);
                });
    }

    private void decryptAndDisplayContent(byte[] encryptedData) {
        String decryptionCode = decryptionCodeInput.getText().toString().trim();
        try {
            byte[] decodedKey = Base64.decode(decryptionCode, Base64.DEFAULT);
            SecretKey originalKey = new SecretKeySpec(decodedKey, 0, decodedKey.length, "AES");

            Cipher cipher = Cipher.getInstance("AES");
            cipher.init(Cipher.DECRYPT_MODE, originalKey);

            byte[] decryptedData = cipher.doFinal(encryptedData);
            String decryptedContent = new String(decryptedData);

            decryptedContentText.setText(decryptedContent);
            Toast.makeText(this, "File decrypted successfully", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            decryptedContentText.setText("Decryption failed. Invalid code.");
            Toast.makeText(this, "Decryption failed", Toast.LENGTH_SHORT).show();
            Log.e("FileReceiveActivity", "Decryption failed", e);
        } finally {
            decryptionProgress.setVisibility(View.GONE);
        }
    }
}
