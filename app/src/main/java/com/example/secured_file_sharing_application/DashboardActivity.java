package com.example.secured_file_sharing_application;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.database.DatabaseReference;
import com.google.firebase.database.FirebaseDatabase;

import com.google.firebase.database.DataSnapshot;
import com.google.firebase.database.DatabaseError;
import com.google.firebase.database.ValueEventListener;
import java.util.ArrayList;
import java.util.List;


public class DashboardActivity extends AppCompatActivity {
    private UserAdapter userAdapter;
    private List<User> userList;
    private DatabaseReference usersRef;
    private Button btnFileShare, btnFileReceive;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_dashboard);

        RecyclerView usersRecyclerView = findViewById(R.id.usersRecyclerView);
        usersRecyclerView.setLayoutManager(new LinearLayoutManager(this));

        userList = new ArrayList<>();
        userAdapter = new UserAdapter(userList, this);
        usersRecyclerView.setAdapter(userAdapter);

        usersRef = FirebaseDatabase.getInstance().getReference("Users");

        loadUsers();

        btnFileShare = findViewById(R.id.btn_file_share);
        btnFileReceive = findViewById(R.id.btn_file_receive);
        // Set up File Share button to open FileShareActivity
        btnFileShare.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent intent = new Intent(DashboardActivity.this, FileShareActivity.class);
                startActivity(intent);
            }
        });

        // Set up File Receive button to open FileReceiveActivity
        btnFileReceive.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent intent = new Intent(DashboardActivity.this, FileReceiveActivity.class);
                startActivity(intent);
            }
        });
    }

    private void loadUsers() {
        usersRef.addValueEventListener(new ValueEventListener() {
            @SuppressLint("NotifyDataSetChanged")
            @Override
            public void onDataChange(@NonNull DataSnapshot snapshot) {
                userList.clear();
                for (DataSnapshot userSnapshot : snapshot.getChildren()) {
                    User user = userSnapshot.getValue(User.class);
                    if (user != null) {
                        userList.add(user);
                    }
                }
                userAdapter.notifyDataSetChanged();
            }

            @Override
            public void onCancelled(@NonNull DatabaseError error) {
                Toast.makeText(DashboardActivity.this, "Failed to load users", Toast.LENGTH_SHORT).show();
                Log.e("DashboardActivity", "loadUsers:onCancelled", error.toException());
            }
        });
    }
}

