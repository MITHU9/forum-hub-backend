require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cookieParser());
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());

//MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.uvg1v.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const userCollection = client.db("forumHubStore").collection("users");
    const postCollection = client.db("forumHubStore").collection("posts");
    const announcementCollection = client
      .db("forumHubStore")
      .collection("announcements");
    const commentCollection = client.db("forumHubStore").collection("comments");
    const tagsCollection = client.db("forumHubStore").collection("tags");

    //auth related APIs
    app.post("/jwt", (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.JWT_SECRET, {
        expiresIn: "5h",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({
          success: true,
        });
    });

    //verify token
    const verifyToken = (req, res, next) => {
      const token = req.cookies?.token;
      if (!token) {
        return res
          .status(401)
          .send({ message: "Access Denied! unauthorized user" });
      }
      try {
        const verified = jwt.verify(token, process.env.JWT_SECRET);
        req.user = verified;
        next();
      } catch (error) {
        res.status(400).send({ message: "Invalid Token" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      const userEmail = req.user.email;
      const user = await userCollection.findOne({ email: userEmail });

      if (user.role === "admin") {
        next();
      } else {
        return res
          .status(401)
          .send({ message: "Access Denied! unauthorized user" });
      }
    };

    //clear cookie on logout
    app.post("/logout", (req, res) => {
      res
        .clearCookie("token", {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({ success: true });
    });

    //make a user an admin
    app.patch(
      "/users/make-admin/",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const userEmail = req.query.email;

        const user = await userCollection.findOne({ email: userEmail });

        const filter = { email: userEmail };

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        if (user.role === "admin") {
          const updateDoc = {
            $set: {
              role: "user",
            },
          };
          await userCollection.updateOne(filter, updateDoc);
          return res.send({ success: true });
        }

        const updateDoc = {
          $set: {
            role: "admin",
          },
        };

        await userCollection.updateOne(filter, updateDoc);

        res.send({ success: true });
      }
    );

    //add a new user to the database
    app.post("/new-user", async (req, res) => {
      const userData = req.body;

      const user = await userCollection.findOne({ email: userData.email });

      if (!user) {
        await userCollection.insertOne(userData);
      }
      res.send({ success: true });
    });

    //get my profile data
    app.get("/my-profile", verifyToken, async (req, res) => {
      const userEmail = req.query.email;

      const user = await userCollection.findOne({ email: userEmail });
      res.send(user);
    });

    //get all users
    app.get("/all-users", verifyToken, verifyAdmin, async (req, res) => {
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    //update user badges
    app.patch("/update-badge", verifyToken, async (req, res) => {
      const userEmail = req.query.email;

      const filter = { email: userEmail };
      const updateDoc = {
        $set: {
          badge: "Gold",
        },
      };
      await userCollection.updateOne(filter, updateDoc);

      res.send({ success: true });
    });

    //search users
    app.get("/search-users", verifyToken, verifyAdmin, async (req, res) => {
      const query = req.query.q;
      const users = await userCollection
        .find({ username: { $regex: query, $options: "i" } })
        .toArray();
      res.send(users);
    });

    //payment intent API for stripe
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: parseInt(amount * 100),
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    //add a new post to the database
    app.post("/new-post", verifyToken, async (req, res) => {
      const postData = req.body;

      try {
        postData.createdAt = new Date();

        await postCollection.insertOne(postData);
        res.send({ success: true });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });

    //get all posts
    app.get("/all-posts", async (req, res) => {
      const result = await postCollection
        .aggregate([
          {
            $lookup: {
              from: "commentCollection",
              localField: "_id",
              foreignField: "postId",
              as: "comments",
            },
          },
          {
            $addFields: {
              commentsCount: { $size: "$comments" },
              votesCount: {
                $subtract: ["$upVotes", "$downVotes"],
              },
            },
          },
          {
            $project: {
              comments: 0,
            },
          },
          {
            $sort: {
              createdAt: -1,
            },
          },
        ])
        .toArray();

      res.send(result);
    });

    //post a comment on a post
    app.post("/new-comment", verifyToken, async (req, res) => {
      const { comment } = req.body;
      try {
        comment.createdAt = new Date();
        comment.postId = new ObjectId(comment.postId);

        await commentCollection.insertOne(comment);
        res.send({ success: true });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });

    //report a comment
    app.patch("/report-comment/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const { feedbacks } = req.body;

      //console.log(feedbacks, id);

      try {
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            feedbacks,
          },
        };

        await commentCollection.updateOne(filter, updateDoc);

        res.send({ success: true });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });

    //get all reported comments
    app.get(
      "/all-reported-comments",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const comments = await commentCollection
          .find({ feedbacks: { $ne: "", $exists: true } })
          .toArray();
        res.send(comments);
      }
    );

    //mark a comment as resolved
    app.patch(
      "/resolve-comment/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;

        try {
          const filter = { _id: new ObjectId(id) };
          const updateDoc = {
            $set: {
              feedbacks: "",
            },
          };

          await commentCollection.updateOne(filter, updateDoc);

          res.send({ success: true });
        } catch (error) {
          console.error(error);
          res
            .status(500)
            .send({ success: false, message: "Internal Server Error" });
        }
      }
    );

    //delete a comment
    app.delete("/delete-comment/:id", verifyToken, async (req, res) => {
      const commentId = req.params.id;

      try {
        await commentCollection.deleteOne({ _id: new ObjectId(commentId) });
        res.send({ success: true });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });

    //get all comments of a post
    app.get("/post-comments/:id", verifyToken, async (req, res) => {
      const postId = req.params.id;

      const comments = await commentCollection
        .find({ postId: new ObjectId(postId) })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(comments);
    });

    //comment count of a post
    app.get("/comment-count", verifyToken, verifyAdmin, async (req, res) => {
      const userCount = await userCollection.estimatedDocumentCount();
      const postCount = await postCollection.estimatedDocumentCount();
      const count = await commentCollection.estimatedDocumentCount();
      res.send({ count, userCount, postCount });
    });

    //Increase upVotes of a post
    app.post("/post-upvote/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const { userEmail } = req.body;
      //console.log(userEmail);

      try {
        const post = await postCollection.findOne({ _id: new ObjectId(id) });

        if (!post) {
          return res.status(404).send({ message: "Post not found" });
        }

        // Check if the user has already voted
        const existingVote = post.votes?.find(
          (vote) => vote.userEmail === userEmail
        );

        if (existingVote) {
          if (existingVote.voteType === "up") {
            // Remove upvote
            await postCollection.updateOne(
              { _id: new ObjectId(id) },
              {
                $pull: { votes: { userEmail } },
                $inc: { upVotes: -1 },
              }
            );
            return res.send({ message: "Upvote removed" });
          } else {
            // Switch vote from down to up
            await postCollection.updateOne(
              { _id: new ObjectId(id), "votes.userEmail": userEmail },
              {
                $set: { "votes.$.voteType": "up" },
                $inc: { upVotes: 1, downVotes: -1 },
              }
            );
            return res.send({ message: "Vote switched to upvote" });
          }
        } else {
          // Add new upvote
          await postCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $push: { votes: { userEmail, voteType: "up" } },
              $inc: { upVotes: 1 },
            }
          );
          return res.send({ message: "Upvote added" });
        }
      } catch (error) {
        console.error("Error in upvote:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // Handle downvote with toggle functionality
    app.post("/post-downvote/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const { userEmail } = req.body;

      try {
        const post = await postCollection.findOne({ _id: new ObjectId(id) });

        if (!post) {
          return res.status(404).send({ message: "Post not found" });
        }

        // Check if the user has already voted
        const existingVote = post.votes?.find(
          (vote) => vote.userEmail === userEmail
        );

        if (existingVote) {
          if (existingVote.voteType === "down") {
            // Remove downvote
            await postCollection.updateOne(
              { _id: new ObjectId(id) },
              {
                $pull: { votes: { userEmail } },
                $inc: { downVotes: -1 },
              }
            );
            return res.send({ message: "Downvote removed" });
          } else {
            // Switch vote from up to down
            await postCollection.updateOne(
              { _id: new ObjectId(id), "votes.userEmail": userEmail },
              {
                $set: { "votes.$.voteType": "down" },
                $inc: { downVotes: 1, upVotes: -1 },
              }
            );
            return res.send({ message: "Vote switched to downvote" });
          }
        } else {
          // Add new downvote
          await postCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $push: { votes: { userEmail, voteType: "down" } },
              $inc: { downVotes: 1 },
            }
          );
          return res.send({ message: "Downvote added" });
        }
      } catch (error) {
        console.error("Error in downvote:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    //get post details
    app.get("/post-details/:id", async (req, res) => {
      const postId = req.params.id;

      const post = await postCollection.findOne({ _id: new ObjectId(postId) });
      res.send(post);
    });

    //sort posts by popularity
    app.get("/all-posts/sort-by-popularity", async (req, res) => {
      const result = await postCollection
        .aggregate([
          {
            $addFields: {
              votesCount: {
                $subtract: ["$upVotes", "$downVotes"],
              },
            },
          },
          {
            $sort: {
              votesCount: -1,
            },
          },
        ])
        .toArray();

      res.send(result);
    });

    //get posts of a particular user
    app.get("/my-posts", verifyToken, async (req, res) => {
      const userEmail = req.query.email;

      const posts = await postCollection
        .find({ authorEmail: userEmail })
        .toArray();
      res.send(posts);
    });

    //my recent 3 posts
    app.get("/my-recent-posts", verifyToken, async (req, res) => {
      const userEmail = req.query.email;

      try {
        const posts = await postCollection
          .find({ authorEmail: userEmail })
          .sort({ createdAt: -1 })
          .limit(3)
          .toArray();

        res.send(posts);
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });

    //delete a post
    app.delete("/delete-post/:id", verifyToken, async (req, res) => {
      const postId = req.params.id;

      try {
        await postCollection.deleteOne({ _id: new ObjectId(postId) });
        res.send({ success: true });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });

    //create a new announcement
    app.post(
      "/new-announcement",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const announcementData = req.body;

        try {
          announcementData.createdAt = new Date();

          await announcementCollection.insertOne(announcementData);
          res.send({ success: true });
        } catch (error) {
          console.error(error);
          res
            .status(500)
            .send({ success: false, message: "Internal Server Error" });
        }
      }
    );

    //get all announcements
    app.get("/all-announcements", async (req, res) => {
      const announcements = await announcementCollection.find().toArray();
      res.send(announcements);
    });

    //get announcement count
    app.get("/announcement-count", async (req, res) => {
      const count = await announcementCollection.estimatedDocumentCount();
      res.send({ count });
    });

    //add a new tags to the database
    app.post("/new-tag", verifyToken, verifyAdmin, async (req, res) => {
      const tagData = req.body;

      const tag = await tagsCollection.findOne({ tagName: tagData.tagName });

      if (!tag) {
        await tagsCollection.insertOne(tagData);
      }
      res.send({ success: true });
    });

    //get all tags
    app.get("/all-tags", async (req, res) => {
      const tags = await tagsCollection.find().toArray();
      res.send(tags);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    //await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
