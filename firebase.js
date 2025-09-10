// Firebase configuration and initialization
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

// Your web app's Firebase configuration
// Replace with your actual Firebase config
const firebaseConfig = {
   apiKey: "AIzaSyDlxhGbuQetnWFHOiMgUKtgPKh-swhRndY",
  authDomain: "student-risk-dashboard.firebaseapp.com",
  projectId: "student-risk-dashboard",
  storageBucket: "student-risk-dashboard.firebasestorage.app",
  messagingSenderId: "528813972460",
  appId: "1:528813972460:web:91a8d00a5ec13a3d2d7ec9",
  measurementId: "G-J531FCYHXL"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

export default app;