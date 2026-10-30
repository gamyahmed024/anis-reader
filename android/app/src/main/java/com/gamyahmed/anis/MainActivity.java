package com.gamyahmed.anis;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AnisVoicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
