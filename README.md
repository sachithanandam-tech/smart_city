# Smart City Service Management System

**Team Members:** Kavipriyan P (2503917720521055) · Sachithanandam S (2503917720521090) · Kabilan B (69IT013)

A full-stack **Smart City Service Management System** implementing all **10 core Java OOP concepts**, complete utility billing (Electricity, Water, Parking), discount & tax orchestration, UPI/Card payment gateway, multithreaded request processing, persistent database storage, file handling, and audit logging.

---

## Architecture & Directory Structure

```text
├── server.ts                        # Live Full-Stack Express API + SQLite + File/Log/Worker Engine
├── src/                             # React 19 + TypeScript + Tailwind CSS v4 + Chart.js Frontend
├── java-backend/                    # Complete Java 17 Spring Boot + Maven Backend (11 packages)
│   ├── pom.xml
│   └── src/main/java/com/smartcity/
│       ├── model/                   # Citizen (Encapsulation), CityService & subclasses (Inheritance/Polymorphism)
│       ├── interfaces/              # PaymentMethod, UPIPayment, CardPayment
│       ├── exception/               # 5 Custom Exceptions + GlobalExceptionHandler
│       ├── threading/               # BillProcessingWorker, ServiceRequestProcessor, AsyncNotificationDispatcher
│       ├── utility/                 # FileRecordManager (citizens.txt, transactions.txt)
│       ├── collections/             # SmartCityRegistry (ArrayList, HashMap, LinkedList)
│       ├── logging/                 # SmartCityLogger (java.util.logging.Logger)
│       ├── events/                  # Domain Events + SmartCityEventListener
│       ├── repository/              # Spring Data JPA Repositories
│       ├── service/                 # SmartCityServiceManager
│       └── controller/              # SmartCityRestController
├── database/smart_city_schema.sql   # MySQL 8 DDL + Foreign Keys + Seed Data
└── docs/PROJECT_DOCUMENTATION.md    # Complete 19-Section Academic Documentation & Diagrams
```

---

## Exact Utility & Payment Rules

- **Electricity:** First 100 units @ Rs. 1.50/unit · 101–200 units @ Rs. 2.50/unit · >200 units @ Rs. 4.00/unit + **5% tax**
- **Water:** First 20 units @ Rs. 10.00/unit · >20 units @ Rs. 15.00/unit + **5% tax**
- **Parking:** Bike @ Rs. 10/hr · Car @ Rs. 30/hr · Bus @ Rs. 50/hr + **5% tax**
- **Payments:** UPI (**0% fee**) · Card (**1.5% fee** of final payable) · Rejects insufficient payments · Computes exact balance returned

---

## Running the Live Web Application

```bash
npm install
npm run dev
```
Open `http://localhost:3000`. Use **Sign in as Demo Administrator** on the login page to enter the dashboard immediately.

## Running the Java Spring Boot Backend (Standalone)

1. Import `database/smart_city_schema.sql` into MySQL 8:
   ```bash
   mysql -u root -p < database/smart_city_schema.sql
   ```
2. Configure `DB_USERNAME` and `DB_PASSWORD` environment variables or update `java-backend/src/main/resources/application.properties`.
3. Run via Maven:
   ```bash
   cd java-backend
   mvn spring-boot:run
   ```
