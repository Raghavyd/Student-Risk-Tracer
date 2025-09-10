const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

// Initialize Firebase Admin
admin.initializeApp();

// Email configuration (replace with your actual email service)
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: 'your-email@gmail.com', // Replace with your email
    pass: 'your-app-password' // Replace with your app password
  }
});

// Cloud Function to send email alerts for high-risk students
exports.sendRiskAlert = functions.firestore
  .document('students/{studentId}')
  .onCreate(async (snap, context) => {
    const studentData = snap.data();
    
    // Check if student has high risk (Red)
    if (studentData.risk === 'Red') {
      const emailContent = {
        from: 'your-email@gmail.com',
        to: 'mentor@example.com', // Replace with actual mentor email
        subject: '🚨 High Risk Student Alert - Immediate Attention Required',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #1f2937; color: #ffffff; border-radius: 12px; overflow: hidden;">
            <div style="background: linear-gradient(135deg, #ef4444, #dc2626); padding: 20px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px; font-weight: bold;">🚨 High Risk Student Alert</h1>
            </div>
            
            <div style="padding: 30px;">
              <h2 style="color: #ef4444; margin-top: 0;">Student Requires Immediate Attention</h2>
              
              <div style="background-color: #374151; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="margin-top: 0; color: #ffffff;">Student Details:</h3>
                <table style="width: 100%; color: #d1d5db;">
                  <tr>
                    <td style="padding: 8px 0; font-weight: bold;">Name:</td>
                    <td style="padding: 8px 0;">${studentData.name}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; font-weight: bold;">Attendance:</td>
                    <td style="padding: 8px 0; color: ${studentData.attendance < 75 ? '#ef4444' : '#10b981'};">
                      ${studentData.attendance}% ${studentData.attendance < 75 ? '(Below 75%)' : ''}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; font-weight: bold;">Test Score:</td>
                    <td style="padding: 8px 0; color: ${studentData.score < 40 ? '#ef4444' : '#10b981'};">
                      ${studentData.score} ${studentData.score < 40 ? '(Below 40)' : ''}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; font-weight: bold;">Fee Status:</td>
                    <td style="padding: 8px 0; color: ${studentData.fee.toLowerCase() === 'unpaid' ? '#ef4444' : '#10b981'};">
                      ${studentData.fee} ${studentData.fee.toLowerCase() === 'unpaid' ? '(Payment Required)' : ''}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; font-weight: bold;">Risk Level:</td>
                    <td style="padding: 8px 0;">
                      <span style="background-color: #ef4444; color: white; padding: 4px 12px; border-radius: 16px; font-weight: bold;">
                        🔴 HIGH RISK
                      </span>
                    </td>
                  </tr>
                </table>
              </div>
              
              <div style="background-color: #fef3c7; color: #92400e; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <h4 style="margin-top: 0;">⚠️ Risk Factors Identified:</h4>
                <ul style="margin: 0; padding-left: 20px;">
                  ${studentData.attendance < 75 ? '<li>Low attendance rate (below 75%)</li>' : ''}
                  ${studentData.score < 40 ? '<li>Poor academic performance (below 40)</li>' : ''}
                  ${studentData.fee.toLowerCase() === 'unpaid' ? '<li>Outstanding fee payment</li>' : ''}
                </ul>
              </div>
              
              <div style="background-color: #dbeafe; color: #1e40af; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <h4 style="margin-top: 0;">📋 Recommended Actions:</h4>
                <ul style="margin: 0; padding-left: 20px;">
                  <li>Schedule immediate one-on-one meeting with student</li>
                  <li>Contact parents/guardians to discuss concerns</li>
                  <li>Develop personalized intervention plan</li>
                  <li>Monitor progress closely over next 2 weeks</li>
                  ${studentData.fee.toLowerCase() === 'unpaid' ? '<li>Follow up on fee payment immediately</li>' : ''}
                </ul>
              </div>
              
              <div style="text-align: center; margin-top: 30px;">
                <p style="color: #9ca3af; font-size: 14px;">
                  This alert was generated automatically by the Student Risk Tracking System.<br>
                  Time: ${new Date().toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        `
      };
      
      try {
        await transporter.sendMail(emailContent);
        console.log(`Risk alert email sent for student: ${studentData.name}`);
        
        // Log the alert in Firestore for tracking
        await admin.firestore().collection('alerts').add({
          studentId: context.params.studentId,
          studentName: studentData.name,
          riskLevel: studentData.risk,
          emailSent: true,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          alertType: 'high_risk_student'
        });
        
      } catch (error) {
        console.error('Failed to send risk alert email:', error);
        
        // Log the failed alert
        await admin.firestore().collection('alerts').add({
          studentId: context.params.studentId,
          studentName: studentData.name,
          riskLevel: studentData.risk,
          emailSent: false,
          error: error.message,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          alertType: 'high_risk_student'
        });
      }
    }
  });

// Function to send daily risk summary (optional)
exports.sendDailyRiskSummary = functions.pubsub
  .schedule('0 9 * * *') // Daily at 9 AM
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    try {
      const studentsRef = admin.firestore().collection('students');
      const snapshot = await studentsRef.get();
      
      const riskSummary = {
        total: 0,
        red: 0,
        yellow: 0,
        green: 0
      };
      
      const highRiskStudents = [];
      
      snapshot.forEach(doc => {
        const student = doc.data();
        riskSummary.total++;
        
        switch(student.risk) {
          case 'Red':
            riskSummary.red++;
            highRiskStudents.push(student);
            break;
          case 'Yellow':
            riskSummary.yellow++;
            break;
          case 'Green':
            riskSummary.green++;
            break;
        }
      });
      
      // Only send email if there are high-risk students
      if (riskSummary.red > 0) {
        const summaryEmail = {
          from: 'your-email@gmail.com',
          to: 'mentor@example.com',
          subject: `📊 Daily Risk Summary - ${riskSummary.red} High Risk Students`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>📊 Daily Student Risk Summary</h2>
              <p>Date: ${new Date().toDateString()}</p>
              
              <div style="display: flex; gap: 20px; margin: 20px 0;">
                <div style="background: #fef3c7; padding: 15px; border-radius: 8px; flex: 1;">
                  <h3 style="color: #92400e; margin-top: 0;">Total Students</h3>
                  <p style="font-size: 24px; font-weight: bold; margin: 0;">${riskSummary.total}</p>
                </div>
                <div style="background: #fee2e2; padding: 15px; border-radius: 8px; flex: 1;">
                  <h3 style="color: #b91c1c; margin-top: 0;">High Risk</h3>
                  <p style="font-size: 24px; font-weight: bold; margin: 0; color: #ef4444;">${riskSummary.red}</p>
                </div>
              </div>
              
              ${riskSummary.red > 0 ? `
                <h3>🚨 High Risk Students Requiring Attention:</h3>
                <ul>
                  ${highRiskStudents.map(student => `
                    <li><strong>${student.name}</strong> - Attendance: ${student.attendance}%, Score: ${student.score}, Fee: ${student.fee}</li>
                  `).join('')}
                </ul>
              ` : ''}
            </div>
          `
        };
        
        await transporter.sendMail(summaryEmail);
        console.log('Daily risk summary sent successfully');
      }
      
    } catch (error) {
      console.error('Failed to send daily risk summary:', error);
    }
  });

// Health check function
exports.healthCheck = functions.https.onRequest((req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    message: 'Student Risk Tracker Cloud Functions are running'
  });
});