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
    origin: ["http://localhost:5173", "https://forumhub-by-mithu9.netlify.app"],
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
    //await client.connect();

    const userCollection = client.db("forumHubStore").collection("users");
    const postCollection = client.db("forumHubStore").collection("posts");
    const announcementCollection = client
      .db("forumHubStore")
      .collection("announcements");
    const commentCollection = client.db("forumHubStore").collection("comments");
    const tagsCollection = client.db("forumHubStore").collection("tags");
    const searchTermCollection = client
      .db("forumHubStore")
      .collection("searchTerms");

    //auth related APIs
    app.post("/jwt", async (req, res) => {
      const { email } = req.body;

      const user = await userCollection.findOne({ email });

      if (!user) {
        return res.status(401).send({ message: "User not found" });
      }

      const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
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
      const userId = req.user.userId;
      const user = await userCollection.findOne({ _id: userId });

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
        await userCollection.insertOne({ ...userData, role: "user" });
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
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const search = req.query.search || "";

      const skip = (page - 1) * limit;

      try {
        const filter = search
          ? { username: { $regex: search, $options: "i" } }
          : {};

        const users = await userCollection
          .find(filter)
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send(users);
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: "Failed to fetch users" });
      }
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
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 5;

      const tag = req.query.searchTerm || "";

      const query = {
        ...(tag && { tags: { $regex: tag, $options: "i" } }),
        visibility: { $ne: "private" },
      };

      const skip = (page - 1) * limit;

      const result = await postCollection
        .aggregate([
          {
            $match: query,
          },
          {
            $addFields: {
              votesCount: {
                $subtract: ["$upVotes", "$downVotes"],
              },
            },
          },
          {
            $sort: {
              createdAt: -1,
            },
          },
          {
            $skip: skip,
          },
          {
            $limit: limit,
          },
        ])
        .toArray();

      res.send(result);
    });

    //Store search term in the database
    app.post("/search-term", async (req, res) => {
      const searchTerm = req.body;

      searchTerm.createdAt = new Date();

      await searchTermCollection.insertOne(searchTerm);

      res.send({ success: true });
    });

    //get recent most popular search terms
    app.get("/recent-search-terms", async (req, res) => {
      try {
        const recentPopularSearch = await searchTermCollection
          .aggregate([
            {
              $group: {
                _id: "$searchTerm",
                count: { $sum: 1 },
                latestCreatedAt: { $max: "$createdAt" },
              },
            },
            { $sort: { count: -1, latestCreatedAt: -1 } },
            { $limit: 3 },
          ])
          .toArray();

        res.send(recentPopularSearch);
      } catch (error) {
        console.error(error);
        res.status(500).json({
          error:
            "An error occurred while fetching the most popular search term.",
        });
      }
    });

    //post a comment on a post
    app.post("/new-comment", verifyToken, async (req, res) => {
      const { comment } = req.body;
      try {
        comment.createdAt = new Date();
        comment.postId = new ObjectId(comment.postId);

        await commentCollection.insertOne(comment);

        await postCollection.updateOne(
          { _id: comment.postId },
          { $inc: { commentsCount: 1 } }
        );

        res.send({ success: true });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });

    //edit profile about me
    app.patch("/edit-about-me", verifyToken, async (req, res) => {
      const email = req.query.email;
      const { aboutMe } = req.body;

      try {
        const filter = { email: email };
        const updateDoc = {
          $set: {
            aboutMe,
          },
        };

        await userCollection.updateOne(filter, updateDoc);

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

    //all users count
    app.get("/user-count", verifyToken, verifyAdmin, async (req, res) => {
      const count = await userCollection.estimatedDocumentCount();
      res.send({ count });
    });

    //A user post count
    app.get("/user-post-count", verifyToken, async (req, res) => {
      const userEmail = req.query.email;
      const count = await postCollection.countDocuments({
        authorEmail: userEmail,
      });
      res.send({ count });
    });

    //delete a reported comment
    app.delete("/delete-comment/:id", verifyToken, async (req, res) => {
      const commentId = req.params.id;
      const { postId } = req.body;

      try {
        await commentCollection.deleteOne({ _id: new ObjectId(commentId) });

        await postCollection.updateOne(
          {
            _id: new ObjectId(postId),
          },
          {
            $inc: { commentsCount: -1 },
          }
        );

        res.send({ success: true });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });

    //get all comments of a post
    app.get("/post-comments/:id", async (req, res) => {
      const postId = req.params.id;

      const comments = await commentCollection
        .find({ postId: new ObjectId(postId) })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(comments);
    });

    //comment,user and post count
    app.get("/comment-count", verifyToken, verifyAdmin, async (req, res) => {
      const userCount = await userCollection.estimatedDocumentCount();
      const postCount = await postCollection.estimatedDocumentCount();
      const count = await commentCollection.estimatedDocumentCount();
      res.send({ count, userCount, postCount });
    });

    //get comments count of a post
    app.get("/post-comment-count/:id", async (req, res) => {
      const postId = req.params.id;

      const count = await commentCollection.countDocuments({
        postId: new ObjectId(postId),
      });
      res.send({ count });
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

    //all post count
    app.get("/post-count", async (req, res) => {
      const count = await postCollection.estimatedDocumentCount();
      res.send({ count });
    });

    //get posts of a particular user
    app.get("/my-posts", verifyToken, async (req, res) => {
      const userEmail = req.query.email;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;

      const skip = (page - 1) * limit;

      const posts = await postCollection
        .find({ authorEmail: userEmail })
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(posts);
    });

    //update post visibility
    app.patch(
      "/update-post-visibility/:postId",
      verifyToken,
      async (req, res) => {
        const { postId } = req.params;
        const { visibility } = req.body;

        try {
          await postCollection.updateOne(
            { _id: new ObjectId(postId) },
            { $set: { visibility: visibility } }
          );
          res.send({ success: true });
        } catch (error) {
          console.error(error);
          res
            .status(500)
            .json({ success: false, message: "Internal Server Error" });
        }
      }
    );

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

        await commentCollection.deleteMany({ postId: new ObjectId(postId) });

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
      const announcements = await announcementCollection
        .find()
        .limit(3)
        .sort({ createdAt: -1 })
        .toArray();
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
        res.send({ success: true });
      }
      res.send({ success: false });
    });

    //get all tags
    app.get("/all-tags", async (req, res) => {
      const tags = await tagsCollection.find().toArray();
      res.send(tags);
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
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
