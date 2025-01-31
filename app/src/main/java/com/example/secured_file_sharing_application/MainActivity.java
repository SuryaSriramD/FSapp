package com.example.secured_file_sharing_application;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {

    private Button loginButton, SignUpButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // Initialize Buttons
        loginButton = findViewById(R.id.loginButton);
        SignUpButton = findViewById(R.id.sign_up_button);

        // Navigate to DashboardActivity for file sharing
        loginButton.setOnClickListener(v -> {
            Intent intent = new Intent(MainActivity.this, LoginActivity.class);
            startActivity(intent);
        });

        // Navigate to FileReceiveActivity to view received files
        SignUpButton.setOnClickListener(v -> {
            Intent intent = new Intent(MainActivity.this, FileReceiveActivity.class);
            startActivity(intent);
        });
    }
}
